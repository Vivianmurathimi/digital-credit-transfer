# The reviewer side, in plain language

How reviewers get access, what they see, how decisions work and what happens automatically.
Each part names the file where it lives.

## The basic rules

- **One application = one target PTE course.** A student who wants three courses recognised sends three applications. So each application has exactly one decision and one final grade.
- **One active reviewer per programme** (Computer Science Engineering, Civil Engineering…). The database enforces it: a unique index allows only one reviewer per programme who is not deactivated (migration 010).
- **Reviewers only ever see their own programme.** Applications, students and files of other programmes don't exist for them: they get the same "not found" as for something that really doesn't exist.

## 1. Getting access: invites (`routes/reviewerInvites.js`)

Reviewers never register themselves (registering with a staff address is refused). The superadmin invites them:

1. **Invite.** The superadmin sends an email address and a programme (`POST /api/users/invite-reviewer`). The address is checked and lowercased; an address that already belongs to a student or an active reviewer is refused. If the programme already has a reviewer, the superadmin must say `replace: true`.
2. **The link.** The invite email (in Hungarian, English or German) contains a link that works **once** and for **7 days**. Only a SHA-256 hash of the link's secret is stored, so even someone reading the database can't use it. A new invite to the same address, or "resend", makes the old link stop working; an invite can also be cancelled.
3. **Accepting.** The person opens the link, chooses a password (at least 8 characters; the same rule everywhere, `utils/passwordRules.js`) and, for a new account, gives their name. The accept page is rate-limited.
4. **Takeover, in one database transaction:**
   - the programme's current reviewer is deactivated (only if the invite said "replace"),
   - the new reviewer's account is created, or, for someone who was a reviewer before, reactivated (same account and name, new password, possibly a new programme),
   - the programme's **open** applications (pending, needs info) move to the new reviewer. Decided applications keep the reviewer who decided them.

   Until the moment of acceptance the old reviewer keeps full access, so there is never a programme without anyone.
5. **Removing a reviewer** (`PUT /api/users/:id/remove-reviewer`): the account is deactivated, not deleted (their name must stay on their past decisions). They are refused from their very next request and can't log in. Their open applications have no reviewer until a new one accepts an invite.

A deactivated reviewer keeps the role "reviewer" but does not count as the programme's reviewer and is refused everywhere. Every request re-reads the role, programme and deactivation from the database (`middleware/verifyToken.js`), so a change takes effect immediately, not when a login token expires.

## 2. Programme scoping: who sees what (`utils/reviewers.js`, `utils/fileOwner.js`)

- Every reviewer query is limited to `programme_id = the reviewer's programme`, read from the database on each request.
- **Files:** a reviewer may open a file only if an application of their own programme names it, in any of the five places a file can appear: transcript, syllabus, grading-system document, reply file, or the older reply-file list. Anything else gets "not found".
- **The superadmin** sees everything. To see exactly what one reviewer sees, the superadmin "impersonates" them: the dashboard adds `?as_reviewer=<id>`, which is only a view filter. Anything the superadmin does there is still recorded as done by **Admin**, never in the reviewer's name.
- Lists and details never contain email addresses or internal user ids; an admin's step shows as "Admin", the system's as "System".

## 3. The reviewer dashboard (`routes/reviewer.js`, frontend `components/reviewer/`)

- **Tabs:** Pending (waiting for a decision, including replies from students), Needs Info (waiting for the student), Completed (approved and rejected **in the current semester**). Withdrawn applications are never shown.
- **Each row:** student, target course, how many days it has been waiting since its last action, and how many other applications the same student has.
- **Details:** the student, the target course, the completed courses with their institutions and an ECTS comparison, every file, the conversation (student's note, reviewer's messages, student's replies, automatic reasons) and a history table of every step.

## 4. Decisions and the status rules (`utils/decisions.js`, `PUT /api/applications/:id/status`)

The only allowed changes, for everyone (reviewer and superadmin alike):

| From | To | Who | What is required |
|---|---|---|---|
| pending | approved | reviewer / admin | a **final grade 2–5** (jeles, jó, közepes, elégséges); a note is optional |
| pending | rejected | reviewer / admin | a **reason** |
| pending | needs info | reviewer / admin | a **message** saying what the student should send |
| needs info | pending | the **student**, by replying | before the reply deadline and before the semester ends |
| pending / needs info | withdrawn | the **student** | — |
| needs info / pending | rejected | the **system** | see section 5 |

Approved and rejected are **final**. The database itself refuses an approval without a grade (migration 011).

**One decision at a time.** The change is one conditional database update: "set approved WHERE the status is still pending". If two people decide at the same moment, only one update matches; the other gets a clear "already decided" (409) answer. A refused change saves nothing.

**The reply deadline.** When information is requested, the student has until **23:59:59 Budapest time on the third day** after the request (database function `info_reply_deadline`, correct across daylight-saving changes).

**Who decided.** Every decision stores the grade, who decided (`decided_by`, and `decided_by_role`: reviewer, admin or system), when, and the reason or note. Every step also goes into `application_events`, an append-only history the database refuses to change or delete.

**Emails** (`utils/notifyStudent.js`, `utils/notifyReviewer.js`, `utils/emailTemplates.js`), each in the recipient's language:

- **To the student:** submitted, information needed (with the deadline), a reminder 24 hours before the deadline, the decision (with the grade, or the reason), and withdrawn.
- **To the programme's active reviewer:** a new application, the student's reply, and the semester-end reminders.

Emails are sent after the change is saved and never make a request fail. If a programme has no active reviewer, the reviewer email is skipped.

## 5. Automatic actions (`jobs/applicationJobs.js`, `jobs/scheduler.js`)

The backend runs four steps **when it starts and then every 5 minutes**:

1. **Semester close.** Applications still pending or waiting for information when their semester ended become **rejected by System**, reason `SEMESTER_ENDED` ("Not reviewed before the semester closed"). Old drafts are deleted. In the term book they appear as not reviewed before the semester closed.
2. **Reviewer reminders.** If the programme's active reviewer still has undecided applications in a semester that is ending, they get an email **7 days before the end** and again **on the last day**, with both numbers: waiting for their decision, and waiting for the student's reply.
3. **Student reminder.** One email 24 hours before the reply deadline.
4. **No reply in time.** Needs info past its deadline becomes **rejected by System**, reason `NO_INFO_RESPONSE` ("No response to information request").

How it is kept safe:

- **Never twice.** Each change is a conditional update ("still needs info AND past the deadline"), and each reminder is recorded before its email goes out (`info_reminder_sent_at`; the `reviewer_reminders` table, one row per semester, programme and kind). Running again finds nothing left to do.
- **Never in parallel.** A run takes a Postgres advisory lock. A second backend process, or a manual run, skips its turn while another run holds it.
- **Catching up.** Every rule compares with "now" ("the deadline has passed"), not with a clock time. So if the server was off when a deadline passed, the run at startup handles it. A reminder whose time has passed is not sent late: a server that was off all week sends only the last-day reminder.
- **Budapest time.** Deadlines and semester ends are worked out in the database in the Europe/Budapest time zone.
- **Codes, not text.** An automatic rejection stores only its reason code, and every screen, email and the term book translate it (the term book in English).

**Why `setInterval` and not a cron library:** no rule is tied to a time of day, so a check every 5 minutes is always on time, the startup run gives the catch-up for free, and there is no extra dependency.

**For testing:** `npm run jobs:run` runs all steps once. `npm run jobs:run -- --now=2027-01-31T08:00:00Z --yes` pretends it is that moment (refused in production; best used on a copy of the database). The automatic tests (`npm test`) use a fake clock.

## 6. The admin's overview (`routes/adminOverview.js`)

At the top of the admin dashboard, one line per programme shows:

- the active reviewer's name,
- how many applications wait for a decision,
- how many wait for the student's reply,
- the current semester's last day.

A programme without an active reviewer is shown as a red warning.

## 7. The term book (`utils/getTermData.js`, `utils/buildTermBookPdf.js`)

The superadmin generates a PDF for a date range. Per application it shows:

- the status, the final grade (with its Hungarian name), who decided ("Admin" and "System" without a name) and when,
- the reason or note, the courses and the evidence files.

It is stored privately in MinIO.

## Where to check that it all holds

- `npm test` (backend): the jobs with a fake clock, reminders, the lock, emails.
- `npm run security-check` (backend, with the backend running): access by role, programme scoping including files, invites, decisions, the admin overview.
- `npm run check:translations`, `npm run check:reviewer-list` and `npm test` (frontend).
- The browser checklist: `docs/REVIEWER_CHECKLIST.md`.
