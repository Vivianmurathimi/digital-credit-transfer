# The reviewer side, in plain language

How reviewers get access, what they see, how decisions and the semester timeline work, and what
happens automatically. Each part names the file where it lives.

## The basic rules

- **One application = one target PTE course.** A student who wants three courses recognised sends three applications. So each application has exactly one decision and one final grade.
- **Staff are linked to programmes** (round 2: `staff_programmes`, migration 019). Per programme: at most **one main reviewer** (a database rule) and any number of **extra reviewers**. A reviewer may be linked to several programmes. `users.programme_id` is for students only (a database rule too).
- **Who sees a programme's applications:** its main reviewer, always; an extra reviewer only while **allowed to assist** (off by default). A standby extra reviewer sees nothing of that programme. Everyone else gets the same "not found" as for something that really doesn't exist.

## 1. Getting access: invites and links (`routes/staffInvites.js`, `utils/reviewers.js`)

Reviewers and admins never register themselves (registration only ever creates students). The superadmin invites them in the admin menu (**Reviewers**, **Admins**):

1. **Invite.** An email address, a role and, for a reviewer, one or more programmes, each as **main** or **extra** (`POST /api/users/invites`). An address that already belongs to an ACTIVE account is refused. A main role for a programme that already has a main reviewer needs **"swap out the current main reviewer"**; an extra role never replaces anyone. Each invite's status (sent, accepted, expired, cancelled) is worked out from its dates.
2. **The link** (Hungarian, English or German) works **once** and for **7 days**. Only a SHA-256 hash of its secret is stored. A new invite to the same address, or "resend", makes the old link stop working; an invite can also be cancelled.
3. **Accepting.** The person sets a password (at least 8 characters, `utils/passwordRules.js`) and, for a new account, a name. Rate-limited.
4. **The swap, in one transaction** (programmes locked in id order): a main role swaps out the current main reviewer (their link ends; their open applications assigned to them go to the new person; someone left with no programme is deactivated); the account is created, or a deactivated one reactivated (same id and name, new password); then the new links are made (an extra reviewer starts on standby). Until acceptance everyone keeps their access.
5. **Changing an existing reviewer, no invite** (Reviewers screen): add a programme (main or extra), remove from a programme (not the last one), **make an extra reviewer the main one** (asks before swapping out a current main reviewer). **Removing a reviewer** (`PUT /api/users/:id/remove-reviewer`) deactivates the account (never deleted: their name stays on their decisions), ends every link (kept for history) and makes their assigned open applications shared again.
6. **The main reviewer leaves while extra reviewers remain** (removed, taken off, made extra): **nobody is promoted automatically.** Every active admin gets one email (`utils/notifyAdmins.js`) and the Overview warns. An assisting extra reviewer keeps working meanwhile; with only standby extras the programme's applications wait for the admin.

Every request re-reads the role, the deactivation and the reviewer's visible programmes from the database (`middleware/verifyToken.js`), so a change works from the next request on, never only when a login token expires. The very first admin: `npm run make-superadmin -- <email>`.

## 2. Programme scoping and sharing work (`utils/reviewers.js`, `utils/fileOwner.js`, `routes/adminSharing.js`)

- Every reviewer query is limited to the programmes they can see now (one SQL rule, `seesProgrammeSql`): lists, details, files, decisions, the student view, PDFs.
- **Files:** a reviewer may open a file only if an application of a programme they can see names it (transcript, syllabus, grading-system document, reply file, older reply-file list).
- **Assigned or shared.** `applications.assigned_reviewer_id` empty = shared: everyone who can see the programme may decide it. New applications start shared. All optional, in the admin's **Sharing the work** panel per programme: allow an extra reviewer to assist or put them on standby (standby: their open assigned applications become shared), assign or unassign selected open applications (all or nothing), and **distribute evenly** (the unassigned pending ones, oldest first, each to the ticked reviewer with the fewest open applications assigned).
- **The reviewer's list** shows "Assigned to you / to X / Shared" and filters All, Assigned to me, Unassigned. Deciding an application assigned to someone else asks first. **The first decision wins** (section 4).
- **The superadmin** sees everything, and sees exactly what one reviewer sees by **acting as** them (`routes/acting.js`): recorded as Admin, never in the reviewer's name; ends with Exit or after one hour.

## 3. The reviewer dashboard (`routes/reviewer.js`, frontend `components/reviewer/`)

- **Tabs:** Pending, Needs Info, Completed (approved and rejected in the semesters in progress). Withdrawn applications are never shown.
- **Semesters:** several can be in progress (section 6). The picker offers all semesters in progress (default), one of them (with its review deadline), or a past one (read-only). The header names each semester in progress with its review deadline, and the programmes on standby.
- **Each row:** student, target course, waiting days, other applications of the student, who it's assigned to, and the programme's code when the reviewer sees several.
- **Details:** student, target course, completed courses with institutions and an ECTS comparison, every file, the conversation and the full history; **Download as PDF**.
- **PDFs** (round 2, `utils/pdfDownloads.js`): the **PDF book of the reviewer's programmes** for a semester (made on request; marked **"INTERIM – not final"** while the semester is in progress; withdrawn ones left out), and one application as a PDF. Same layout as the admin's book; checked on the server.

## 3b. Past semesters, read-only

- **The admin closes a semester** (section 6), never a date by itself. After the close it's read-only and the PDF book is made. Nothing is deleted.
- **The server enforces it:** any status change on an application of a closed semester is refused with 409 `SEMESTER_ENDED`, for everyone, inside the same conditional update.
- **Evidence is kept:** a file any submitted application uses can't be deleted (409 `FILE_IN_USE`).

## 4. Decisions and the status rules (`utils/decisions.js`, `PUT /api/applications/:id/status`)

| From | To | Who | What is required |
|---|---|---|---|
| pending | approved | reviewer / admin | a **final grade 2–5**; a note is optional |
| pending | rejected | reviewer / admin | a **reason** |
| pending | needs info | reviewer / admin | a **message** |
| needs info | pending | the **student**, by replying | before the reply deadline |
| pending / needs info | withdrawn | the **student** | — |
| needs info | rejected | the **system** | no reply by the deadline (section 5) |
| *anything* | *anything* | nobody, once the semester is closed | 409 `SEMESTER_ENDED` |

Approved and rejected are **final**; the database refuses an approval without a grade. **One decision at a time:** one conditional update ("WHERE the status is still pending"); of two people deciding at once, one succeeds and the other gets 409 `ALREADY_DECIDED`. **The reply deadline:** 23:59:59 Budapest time on the third day after the request. Every step is in `application_events`, an append-only history.

**Emails** (`utils/notifyStudent.js`, `utils/emailTemplates.js`, `jobs/applicationJobs.js`), each in the recipient's language:

- **To the student:** submitted, information needed, a reminder 24 hours before the deadline, the decision, withdrawn.
- **To reviewers** (round 2): no email per new application or reply. **One daily summary** at 07:00 Budapest time (section 5), and the reminders before the review deadline.
- **To the admins:** a main reviewer left while extra reviewers remain; the review deadline passed with undecided applications.

## 5. Automatic actions (`jobs/applicationJobs.js`, `jobs/scheduler.js`)

When the backend starts and then **every 5 minutes**:

1. **Unsent drafts:** when a semester's last-days warning starts, one email per student and semester (`draft_reminders`).
2. **Reviewer daily summary** (round 2): from **07:00 Budapest time** (`DAILY_SUMMARY_HOUR`), on the Budapest clock, each reviewer who can see a programme gets one summary a day of the applications submitted and the student replies since their last summary, in the programmes they can see then (withdrawn left out), with how many wait for their decision now. Nothing new: recorded, no email. Recorded first (`reviewer_summaries`, one row per reviewer and day), so never twice; a server off at 07:00 sends it at the next run that day; off for days: the next summary covers everything since the last one.
3. **Reviewer reminders before the review deadline:** **7 days and 1 day before** it, to everyone who can see the undecided applications, with both numbers. Once per semester, programme, kind and reviewer (`reviewer_reminders`).
4. **The review deadline passed** with applications pending or in needs info: **nothing is rejected.** The admins get one email per semester with the undecided counts per programme (`review_deadline_alerts`).
5. **Student reminder:** 24 hours before the reply deadline.
6. **No reply in time:** needs info past its deadline becomes **rejected by System**, reason `NO_INFO_RESPONSE`.

Kept safe: **never twice** (conditional updates; every email recorded before it is sent), **never in parallel** (a Postgres advisory lock), **catching up** (every rule compares with "now"; a reminder whose time has passed is not sent late), **Budapest time** (worked out in the database), **codes, not text** (automatic reasons are codes, translated everywhere).

**For testing:** `npm run jobs:run` runs every step once; `npm run jobs:run -- --now=2027-01-31T06:00:00Z --yes` pretends it is that moment (refused in production; use a copy of the database). `npm test` uses a fake clock.

## 6. The semester timeline (round 2: `utils/applicationPeriod.js`, `utils/semesters.js`, `utils/semesterClose.js`)

- A semester has an **application period** (opening and closing time; Close now and Reopen until change the closing time), a **review deadline** (`review_end_at`; default applications close + 14 days; a target, never a lock), and a name and last day that are **labels only**.
- **Several semesters can be in progress:** the next one's application period may open while the previous one is still reviewed. **Application periods never overlap** (a database rule), so a new application belongs to exactly one semester. The period rule talks about the semester whose period is open, else the next to open, else the most recent; **late access** submits into its own semester.
- **Reopen until and late access** run up to the review deadline at most; a later or tight end (fewer than 7 days of review left) offers to move the review deadline in the same step. Reopen until is refused if it would overlap the next semester's period.
- **At the review deadline nothing is rejected** (section 5). The admin can extend it, let an extra reviewer assist, or decide as admin.
- **Closing** (admin, Semesters screen): allowed once the application period is over, no late access runs and **nothing is pending or in needs info**, even before the review deadline. The preview lists what blocks it per programme. Nobody is rejected (old closes keep their `SEMESTER_ENDED` records). It ends the late access, deletes unsent drafts unless another application period is open or still to come, makes the semester read-only and creates its PDF book.

## 7. The admin's overview (`routes/adminOverview.js`, `routes/adminPeriod.js`)

One line per programme: the main reviewer, the extra reviewers (assisting or standby), pending and needs-info counts, and the first review deadline. Warnings: a programme nobody can review, a programme without a main reviewer, per semester "review deadline soon", "review deadline passed (nothing rejected)" with counts per programme, and "ready to close".

## 8. The term book (`utils/getTermData.js`, `utils/buildTermBookPdf.js`)

Per closed semester (admin), stored privately in MinIO: cover with counts, index, then each application (status, final grade, who decided, reason, courses, evidence) with its decision line on every page. The reviewer's book and the single-application PDF use the same pages (section 3).

## Where to check that it all holds

- `npm test` (backend): the jobs with a fake clock (daily summary, reminders, review deadline alert, the lock), the period rule with several semesters, the close, the PDFs, emails in every language.
- `npm run security-check` (backend, with the backend running): access by role, programme scoping (also files and PDFs), standby and assisting extra reviewers, one main reviewer per programme, two decisions at once, invites, sharing, the close refused while anything is undecided, no rejection at the review deadline, overlapping application periods refused.
- `npm run check:translations`, `npm run check:missing-keys`, `npm run check:reviewer-list`, `CI=true npm test` (frontend).
- The browser checklist: `docs/REVIEWER_CHECKLIST.md`.
