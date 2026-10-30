# Security tests: student side (Groups 1–10)

This document describes how the access rules of the PTE digital credit transfer system are tested:
- who may call which API route
- what happens to missing, expired or forged login tokens
- that one student can never read or change another student's data
- that a student only sees and applies for their own study programme's courses (Group 2)
- that every field of the application form is checked on the server, and errors name their field (Group 4)
- that uploads follow the file rules (type by real content, size, generated names) and that a syllabus is required when the rules say so (Group 5)
- that a student has only one active application per PTE course (Group 6)
- that the note to the reviewer is limited to 2000 characters, counted the same in browser and server, and that a saved draft of the form is only ever the student's own (Group 7)
- that My Status and the detail view only ever show the student's own applications, without internal fields, and that only the student can withdraw their own application, only while it is waiting (Group 8)
- that the "needs info" reply deadline, the reminder and the automatic rejection work exactly once, also with two backend processes and across a clock change (Group 9)
- that students can only submit inside the current semester's application period with submissions open, that a semester end closes unreviewed applications exactly once, and that a course approved in an earlier semester can't be applied for again (Group 3)
- that every student-facing text and email exists in English, Hungarian and German, with nothing hard-coded (Group 10)

There are five parts:

1. **Automated API check** (`npm run security-check`): 213 checks against the running backend.
2. **Form rules check** (`npm run check:form-rules`): the browser's and the server's form rules give identical results (section 1b).
3. **Background job tests** (`npm test` in `backend/`): reminders, automatic rejections and the semester end with a fake clock (section 1c).
4. **Translation check** (`npm run check:translations` in `frontend/`): missing, unused and inconsistent texts, hard-coded English, emails (section 1d).
5. **Browser checklist**: behaviour that only the frontend can show (redirects, messages, inline errors, downloads).

---

## 1. Automated API check

### How to run it

The check needs test data in **two study programmes**: two students in different programmes, each with an uploaded file and one with an application. In development:

```bash
cd backend
npm run migrate
npm run seed:dev     # one student per programme, with a file and an application
```

Then:

```bash
# 1. Start (or RESTART) the backend, so it runs the current code
#    (it listens on PORT from backend/.env, normally 5050)
cd backend
node server.js

# 2. In a second terminal
cd backend
npm run security-check

# Against another address, e.g. a test server:
SECURITY_CHECK_URL=http://localhost:5099 npm run security-check
```

The script prints `PASS`, `FAIL` or `SKIP` per check and a total in the form `passed / failed / skipped`. It exits with code 0 only if nothing failed. A `SKIP` always shows its reason, and skipped checks are counted in the total and called out at the end. They are never left out silently.

### Safety rules built into the script

- **Changes no data and sends no emails.** Every request is either read-only or one the server must refuse *before* it saves anything. The one exception is the rate-limit checks (section 8), which add rows to `rate_limit_hits`. The script deletes exactly those rows at the end, even after a crash: this computer's IP and its own test addresses, from the start of the run. Otherwise this computer would stay rate-limited for an hour. Other requests:
  - forgot password uses an address that does not exist
  - the only login attempts use wrong passwords
- **Destructive checks are guarded.** "Student A deletes B's file" and the submit checks would really delete or save something if a check were broken. They only run after the read-only check "A opens B's file" has passed; otherwise they are skipped. In addition, every submit check attaches B's file, so even a broken course check would still be stopped by the file check and nothing could be saved.
- **Compatibility probe before any submit test.** Every submit test relies on the server reading the same fields as the script. On 2026-10-28 the check was run against a backend that had not been restarted after a code change: the old code did not understand the new request shape, saw no files, and **saved 32 empty applications** (cleaned up with a dev-data reset). Since then a probe runs first: it is refused by every version (empty target course list), but only the current code reports both of its mistakes with their field paths. Otherwise all submit tests are skipped with "restart the backend". Tested against a real older version of the backend: nothing was saved.
- **Every file the server stores during the check is deleted at the end**, including files an outdated server accepted although it should have refused them.
- **Drafts of students A and B are put back.** The drafts checks (section 4c) save and delete drafts of A and B. Their real drafts are copied first and restored afterwards, also after a crash; the script prints how many it put back. Without migration 006, or against a backend that doesn't know the drafts routes yet, the drafts checks are skipped and the reason is printed.
- **Temporary applications of student A are deleted again.** Section 4d needs a rejected and a withdrawn application to try forbidden changes on. It adds one of each for student A (neither blocks anything), checks that every request was refused and nothing changed, and deletes both with their history, also after a crash. Every withdraw request the script sends is one the server must refuse.
- **The current semester's days and the admin toggle are put back.** Section 4e moves the current semester's days (relative to today) to produce each state of the application period, closes submissions once, and adds a temporary past semester with two applications of student A. Afterwards the days and the toggle are put back and the temporary semester and applications deleted, also after a crash; the script prints what it put back. The current semester is never made to end, so a running background job can never close anything meanwhile. Without a current semester, a temporary one is used.
- **Refuses to run when `NODE_ENV=production`.**
- **Never prints `JWT_SECRET` or any token.** Test tokens are signed locally with the secret from `backend/.env` and only sent to the server.
- **Picks its test users from the database** (read-only):
  - student B: a student with an application and an uploaded file
  - student A: another student with an uploaded file, **preferably in a different programme** than B
  - one reviewer and one superadmin

  If such users are missing, it stops and says what is needed. If A and B are in the same programme, it prints a warning at the start, and the two cross-programme course checks are reported as `SKIP`.

### What it checks

| # | Group | What is checked | Expected |
|---|---|---|---|
| 1 | **No token** | All 21 protected routes: applications, uploads, users, own profile, settings, PTE courses, term archive, refresh-token | `401 NO_TOKEN` |
| 2 | **Bad tokens** | Expired token | `401 TOKEN_EXPIRED` |
| | | Signed with the wrong secret | `401 INVALID_TOKEN` |
| | | Unsigned token (`alg: none`) that claims to be superadmin | `401 INVALID_TOKEN` |
| | | Session older than 8 hours (renewed but past the hard limit) | `401 SESSION_TOO_OLD` |
| | | Token of an account that no longer exists | `401 ACCOUNT_GONE` |
| | | Malformed `Authorization` header | `401 NO_TOKEN` |
| 3 | **Wrong role** | Student: all applications, change a status, user list, change a role, open/close submissions, term archive | `403 FORBIDDEN_ROLE` |
| | | Reviewer: user list, change a role, open/close submissions, generate a term book, upload as a student | `403 FORBIDDEN_ROLE` |
| | | Superadmin on student-only routes ("my applications", submit) | `403 FORBIDDEN_ROLE` |
| 4 | **Student A vs B** | A reads B's applications | `403 FORBIDDEN_ROLE` |
| | | A changes B's language | `403 NOT_OWNER` |
| | | A resubmits B's application | `403 NOT_OWNER` |
| | | A opens B's evidence file | `403 NOT_OWNER` |
| | | A deletes B's evidence file | `403 NOT_OWNER` |
| | | A submits an application with B's file attached | `403 FILES_NOT_OWNED` |
| | **Own profile (`/me`)** | A's token | A's own name, email, Neptun code, programme |
| | | A's token with `?id=<B>` in the address | still A |
| | | B's token | B, not A |
| | | Fields returned | only name, email, role, Neptun code, programme (no password or tokens) |
| | | Cache header | `Cache-Control: no-store` |
| | **Courses by programme** | A's course list | exactly the courses of A's programme |
| | | B's course list | exactly the courses of B's programme |
| | | Any of B's programme's courses in A's list | none *(needs A and B in different programmes)* |
| | | A's list with `?programme=<B's programme>` | unchanged *(needs A and B in different programmes)* |
| | | Fields returned | only id, code, name, credits |
| | | Reviewer's course list | every course (for now) |
| | **Submission** | Another programme's course; own and other mixed; a course id that does not exist | `400 COURSE_NOT_IN_PROGRAMME` |
| | | No course list, an empty list, ids as text, 11 different courses (limit 10) | `400 INVALID_TARGET_COURSES` |
| | | 12 copies of one course (duplicates removed first, so within the limit) | passes the course checks |
| | **Application form (Group 4)** | Someone else's file used as evidence and as grading document | `403 FILES_NOT_OWNED` at **both** `fulfilled_courses[0].file` and `institutions[0].grading_file` |
| | | Someone else's file vs. a file that doesn't exist | identical answer (no way to probe file names) |
| | | Three mistakes in one submit | all three in `errors`, each with its field path, in form order; the first also at the top level |
| | | Credits as text `"5"`, `0`, `-1`, `2.3` | `400 INVALID_CREDITS` |
| | | 60.5 ECTS / 30.5 US credit hours / 120.5 UK credits | `400 INVALID_CREDITS` with `max` 60 / 30 / 120 |
| | | Exactly 60 ECTS, 30 US credit hours, 120 UK credits, and 2.5 ECTS | accepted by every field rule |
| | | No credit system, an unknown one | `400 INVALID_CREDIT_SYSTEM` |
| | | "Other" without a name | `400 INVALID_CREDIT_SYSTEM_OTHER` |
| | | An "Other" name sent with ECTS | accepted (and not stored: see section 1b) |
| | | Institution without a name / country / with country `XX` / without a grading document | `INVALID_INSTITUTION_NAME` / `INVALID_COUNTRY` / `INVALID_COUNTRY` / `GRADING_FILE_MISSING` |
| | | Same institution twice (other case and spaces) | `400 DUPLICATE_INSTITUTION` on the second |
| | | An institution no course uses | `400 INSTITUTION_UNUSED` |
| | | A row pointing to a missing institution | `400 INVALID_INSTITUTION_CHOICE` |
| | | Row without course name / grade / evidence; grade of 21 characters | `INVALID_COURSE_NAME` / `INVALID_GRADE` / `EVIDENCE_MISSING` / `INVALID_GRADE` |
| | | 11 institutions; 21 course rows | `INVALID_INSTITUTIONS` / `INVALID_FULFILLED_COURSES` |
| | | Text the student typed | never repeated in an error answer |
| | | The old request shape (`fulfilled_courses_json`) | refused |
| | **One PTE course (Group 5)** | Two different target courses | `400 INVALID_TARGET_COURSES` |
| | | 12 copies of the same course | counted as one course |
| | **Syllabus rule (Group 5)** | Two fulfilled courses combined, no syllabi | `400 SYLLABUS_REQUIRED` at `fulfilled_courses[0].syllabus_file` and `[1].syllabus_file` |
| | | Credits lower than the PTE course (all ECTS), no syllabus | `400 SYLLABUS_REQUIRED` |
| | | Credits not comparable (US credit hours), no syllabus | `400 SYLLABUS_REQUIRED` |
| | | Two courses, only one with a syllabus | only the missing one is reported |
| | | Enough ECTS from one course, no syllabus | accepted (no syllabus needed) |
| | | Someone else's file as syllabus | `403 FILES_NOT_OWNED` at `fulfilled_courses[0].syllabus_file` |
| | **Compatibility probe** | A submit only the current code refuses with all three field paths (country, target courses, note) | otherwise every submit test is skipped ("restart the backend") |
| | **One application per PTE course (Group 6)** | Student B applies again for the course of B's open application (with A's file, as a safety net) | `409 ALREADY_APPLIED` at `target_course_ids` |
| | **Note limit (Group 7)** | A note of 2001 characters | `400 NOTE_TOO_LONG` at `student_note`, `max` 2000 |
| | | 2000 emoji (`.length` says 4000); 2000 accented letters typed as letter + accent | accepted (counted as 2000 characters after NFC) |
| | | A note that is not text | `400 INVALID_NOTE` |
| | | A reply note ("add missing info") of 2001 characters | `400 NOTE_TOO_LONG` at `student_resubmit_note` |
| 4b | **File uploads (Group 5)** | A PDF | stored under a generated name (random id); the original name is returned |
| | | Downloading it | `Content-Disposition` keeps the original name, accents included (`filename*=UTF-8''tant%C3%A1rgyle%C3%ADr%C3%A1s.pdf`) |
| | | A text file renamed to `.pdf`; a PNG named `.pdf`; a Word file | `400 FILE_TYPE_NOT_ALLOWED` (type taken from the file's first bytes) |
| | | An unchanged upload over 10 MB | `413 FILE_TOO_LARGE`, `max` 10 |
| | | A highlighted file of 11 MB | accepted (limit 15 MB) |
| | | A file over 15 MB | `413 FILE_TOO_LARGE`, refused from its announced size before it is read |
| | | Refused uploads | nothing stored (file count unchanged) |
| | **Request errors (Group 7)** | A request body over 100 KB | `413 REQUEST_TOO_LARGE` as JSON (not an HTML page) |
| | | Broken JSON | `400 INVALID_JSON` as JSON |
| 4c | **Drafts (Group 7)** | Read, save or delete a draft without a token | `401 NO_TOKEN` |
| | | Reviewer reads a draft; superadmin saves one | `403 FORBIDDEN_ROLE` |
| | | A saves a draft with A's file, B's file and a missing file, and reads it back | A's file kept; B's and the missing file removed (`dropped_files` 2); only A's file names returned |
| | | Cache header | `Cache-Control: no-store` |
| | | B reads a draft after A saved one | never A's draft |
| | | A saves with B's id in the address and the body | stored as A's draft; B's draft unchanged |
| | | B deletes a draft | A's draft untouched |
| | | No format version, version as text, a list instead of an object, 11 institutions, 21 course rows, a NUL character | `400 INVALID_DRAFT` at `version` / `data` |
| | | A draft of 210 KB (limit 200 KB) | `413 DRAFT_TOO_LARGE` at `data`, `max` 200 |
| | | A draft request over 256 KB | `413 REQUEST_TOO_LARGE` |
| | | After the refused drafts | the saved draft is unchanged |
| | | A deletes the draft | no draft any more |
| 4d | **My Status and withdrawing (Groups 8 and 9)** | B's list of own applications | only the fields a student may see (no `reviewed_by`, `student_id`, …) |
| | | B's detail view | no internal fields, no `actor_id` in the history; `Cache-Control: no-store` |
| | | A opens B's application in detail; an id that doesn't exist | the same `404 APPLICATION_NOT_FOUND` for both |
| | | Detail with an id that is not a number | `404 APPLICATION_NOT_FOUND` |
| | | Detail without a token; a reviewer uses the student detail route | `401 NO_TOKEN`; `403 FORBIDDEN_ROLE` |
| | | A withdraws B's application; an id that doesn't exist | the same `404 APPLICATION_NOT_FOUND`; B's application unchanged |
| | | Withdraw without a token; as reviewer; as superadmin | `401 NO_TOKEN`; `403 FORBIDDEN_ROLE` |
| | | Reviewer sets the status `withdrawn` | `400 INVALID_STATUS` (only the student can withdraw) |
| | | A withdraws own rejected application; own withdrawn one again | `409 CANNOT_WITHDRAW` |
| | | Reviewer changes a withdrawn application | `409 APPLICATION_WITHDRAWN`; nothing changed |
| | | Changing a history entry in the database | refused by the database (append-only) |
| 4e | **Application period and semesters (Group 3)** | Submit and save a draft before the period starts | state `not_started`; `403 APPLICATION_PERIOD_NOT_STARTED` for both |
| | | Submit during the period; in its last 7 days | states `open` / `last_days`; the period check lets an (empty) form through to the field checks (`400`) |
| | | Submit and save a draft after the period (semester still running) | state `period_over`; `403 NO_APPLICATION_PERIOD` for both |
| | | Submit and save a draft while the admin has closed submissions | state `closed_by_admin`; `403 SUBMISSIONS_CLOSED` for both |
| | | A applies for a course approved in an earlier semester | `409 ALREADY_APPLIED` |
| | | A applies for a course rejected in an earlier semester | passes the duplicate check (stopped at the file check, `403 FILES_NOT_OWNED`: nothing saved) |
| | | A's earlier-semester application in A's list | listed with its semester, not as current |
| | | B opens or withdraws A's earlier-semester application | `404 APPLICATION_NOT_FOUND` |
| 5 | **Allowed reads** | A reads own applications; B opens own file | `200` |
| | | Reviewer reads the application list and opens a student's file | `200` |
| | | Superadmin reads the settings and the user list | `200` |
| 6 | **Public routes** (no token) | Login with an unknown email, and with a real email + wrong password (same answer, so accounts cannot be guessed) | `401 INVALID_CREDENTIALS` |
| | | Register with empty fields | `400 MISSING_FIELDS` |
| | | Forgot password with an unknown address | `200` with the same text as for a real address |
| | | Forgot password with an email that is not text | `400 MISSING_FIELDS` |
| | | Reset password, bad link | `400 INVALID_RESET_LINK` |
| | | Verify email, bad link | `400 INVALID_VERIFY_LINK` |
| | | Email notification link, bad link | `410 INVALID_LINK` |
| | | A stale token sent to a public route is ignored | `401 INVALID_CREDENTIALS` |
| | | Programme list without a token (for the registration form) | `200`, every programme with EN/HU/DE names |
| | | Country list without a token (for the application form) | `200`, ISO codes only |
| | | Register a student without a Neptun code, with 5 characters, or with symbols | `400 INVALID_NEPTUN` |
| | | Register a student with an unknown programme, or without one | `400 INVALID_PROGRAMME` |
| | | Register with an email that is not text | `400 MISSING_FIELDS` |
| | | Register a student with another student's Neptun code, also written in lower case with spaces | `400 NEPTUN_TAKEN` |
| 7 | **CORS** | The frontend address is allowed | `Access-Control-Allow-Origin` set |
| | | Download file names are readable | `Content-Disposition` exposed |
| | | A foreign website gets no CORS headers, and no server error | no CORS headers |
| 8 | **Rate limits** | Forgot password: 5 requests for one unknown address, spelled differently (upper case, spaces) | same `200` reply each time; exactly 3 counted |
| | | Forgot password: 5 requests for one address **at the same moment** | exactly 3 counted (no race) |
| | | Forgot password: this computer's IP over 30 requests | same `200` reply; counting stops at 30 |
| | | Register: this computer's IP over 30 attempts (empty forms, nothing created) | `429 TOO_MANY_REQUESTS` |

**Forgot password, real address:** the script does not call this with a real address, because that would send an email. Reading the code (`backend/routes/auth.js`, forgot-password route) confirms that both cases send the same reply (`200`, same text) at the same point, straight after the database lookup.

**Forgot password timing** was measured separately with a test student in the Mailtrap sandbox (6 requests per set, the first discarded, average of the other 5):

| | Unknown address | Real address |
|---|---|---|
| Before the fix (email sent before replying) | 5 ms | 1877 ms |
| After the fix (reply first, email afterwards) | 3 ms | 4 ms |
| After adding rate limiting | 8 ms | 8 ms |

With rate limiting, the 6 requests for the real address led to only 3 email attempts (the per-address limit).

### Last result

| Date | Server | Result |
|---|---|---|
| 2026-10-28 | local development backend | **62 passed, 0 failed, 0 skipped**; 0 emails sent |
| 2026-10-28 | local development backend, after the forgot-password fix | **63 passed, 0 failed, 0 skipped**; 0 emails sent |
| 2026-10-28 | local development backend, with rate limiting | **67 passed, 0 failed, 0 skipped**; 0 emails sent; all 81 test rate-limit rows removed |
| 2026-10-28 | local development backend, Group 2 (programmes), seeded data | **95 passed, 0 failed, 0 skipped**; 0 emails sent; no applications saved |
| 2026-10-28 | local development backend, Group 4 (application form), seeded data | **130 passed, 0 failed, 0 skipped**; 0 emails sent; no applications saved |
| 2026-10-29 | throwaway copy with migration 004, Group 5 (evidence and file rules) | **144 passed, 0 failed, 0 skipped**; run 5 times in a row for the 16 MB check; no applications saved, test uploads deleted |
| 2026-10-29 | throwaway copy with migration 005, Group 6 and the note limit (Group 7) | **153 passed, 0 failed, 0 skipped**; no applications saved, test uploads deleted |
| 2026-10-29 | throwaway copy with migration 006, drafts (Group 7) | **177 passed, 0 failed, 0 skipped**; a real draft of student A was put back unchanged |
| 2026-10-30 | throwaway copy with migration 008, semesters (Group 3) and the translation sweep (Group 10) | **212 passed, 0 failed, 1 skipped** (213 checks); the skip is the duplicate check, because in the development data student B's only application is withdrawn. Semester days, admin toggle, applications and drafts compared before and after: unchanged |
| 2026-10-30 | throwaway copy with migration 007, My Status, withdrawing, deadline (Groups 8 and 9) | **195 passed, 0 failed, 0 skipped**; the 2 temporary applications deleted. With student B's only application withdrawn (after a browser test), the duplicate check is skipped with "student B has no open application": submit a new one for B to run it |

**One-time tests on throwaway copies of the database (Groups 6 and 7):**

| What | Result |
|---|---|
| Migration 005 on data that already has two active applications for one course | refused, nothing changed; the message says to resolve the duplicates first |
| Two submits for the same course **at the same moment** | one `200`, one `409 ALREADY_APPLIED`; only one application stored |
| A new application after the earlier one was rejected | accepted (rejected doesn't block) |
| Reviewer reopens a rejected application while a newer one for the same course is active | `409 ALREADY_APPLIED`; status unchanged |
| `npm run seed:dev` | fills the new course-code column |
| A real submit with a saved draft | `200`; the draft is gone afterwards |
| Deleting a student account that has a draft | the draft is deleted with it |
| A draft with the student's own uploads | read back with the files' original names |

**One-time tests on throwaway copies of the database (Groups 8 and 9):**

| What | Result |
|---|---|
| Migration 007 on a copy of the development data | every existing application got its "submitted" history entry (marked as rebuilt); applications waiting for information got a fresh, full deadline |
| Deadline of a request on 24 Oct 2026 (the day before winter time), and at 23:30 Budapest time that day | 27 Oct 23:59:59 Budapest time = 22:59:59 UTC, both |
| Deadline of a request on 28 Mar 2026 (the day before summer time) | 31 Mar 23:59:59 Budapest time = 21:59:59 UTC |
| Reviewer asks for information twice, student replies, admin decides | history in this order: submitted, information requested ×2, information added, decided by admin; resubmit count 1 |
| Asking again while waiting for information | the deadline stays the same |
| A reply | the deadline is cleared; a second reply `409 NOT_WAITING_FOR_INFO` |
| Admin decision without a note | the reviewer's note is kept |
| Changing or deleting a history entry directly in the database | refused; deleting the whole application still removes its history |
| Withdraw from "needs info" | withdrawn, deadline cleared, history entry "withdrawn" by the student |
| After withdrawing | withdrawing again `409 CANNOT_WITHDRAW`, a reviewer decision `409 APPLICATION_WITHDRAWN`, a reply `409 NOT_WAITING_FOR_INFO` |
| Withdrawing an approved or rejected application | `409 CANNOT_WITHDRAW` |
| A new application for the course of a withdrawn one | accepted by the database index (withdrawn doesn't block) |
| Withdraw and reply while submissions are closed | both `200` |
| A reply one minute after the deadline (before the job ran) | `409 INFO_DEADLINE_PASSED`; the application stays waiting for the job |
| Backend started with jobs on; with `JOBS_DISABLED=1`; with `JOBS_DISABLED=1` and `NODE_ENV=production` | "Background jobs running every 5 minutes"; a warning; a large ❌ block saying no automatic rejections will happen |
| Dates in My Status in EN/HU/DE, on both sides of the clock change | always Budapest time (e.g. 27 Oct 23:59, 24 Oct 23:30), whatever the computer's time zone |
| Emails: needs info, reminder, withdrawn, automatic rejection, in HU/EN/DE | deadline in the student's language and Budapest time; the automatic rejection shows "Reason: No response to information request." translated |

**One-time tests on throwaway copies of the database (Groups 3 and 10):**

| What | Result |
|---|---|
| Migration 008 on a copy of the development data | applied; no semester yet, so the state is "between semesters" and submitting and saving drafts are refused (`NO_APPLICATION_PERIOD`); reading and deleting a draft still work |
| `npm run semester:create` with 30 February, month 13, days out of order, no name, a name that exists | refused with a message naming the problem |
| `npm run semester:create` overlapping another semester | refused: "It overlaps "…" (2026-09-30 to 2027-01-28): semesters can't overlap." |
| `npm run seed:dev` | creates "Development semester" around today once; existing courses and the applications submitted during it join it; running it again creates nothing more |
| States at the exact boundaries, spring semester opening on 29 Mar 2026 (summer time starts) | 28 Mar 23:59:59 Budapest not started, 29 Mar 00:00 open; last 7 days from 4 Apr 00:00 (UTC+2); 10 Apr 23:59:59 still submitting, 11 Apr 00:00 period over |
| Autumn semester closing on 25 Oct 2026 (winter time starts) | 25 Oct 23:59:59 Budapest (22:59:59 UTC) still submitting; 26 Oct 00:00 (23:00 UTC) period over |
| Admin toggle closed | "closed by admin" only inside the period; never hides "not started" or "period over" |
| `settings/status` | the admin's toggle as before (`isOpen`) plus the state and the semester's Budapest days, no internal ids |
| Course picker with a course of the coming semester | only the current semester's courses; submitting the other one: `400 COURSE_NOT_IN_PROGRAMME` |
| Semester end on a copy with a past semester | pending and needs-info applications rejected with "Not reviewed before the semester closed." (history `auto_rejected` by `system`, one status email each); approved untouched; the current semester untouched; a draft saved during the semester deleted, one saved now kept; a second run changes nothing |
| Reply to a needs-info application after its semester ended | `409 SEMESTER_ENDED` |
| Term book with a semester-end rejection | listed as "Not reviewed before semester close" |
| `npm run check:translations` with a German key removed, a wrong placeholder and an extra key | all three reported, exit code 1 |
| Verification and password-reset emails | built in HU, EN, DE; an unknown language falls back to Hungarian |

---

## 1b. Form rules: browser and server agree

The application form checks every field in the browser first (`frontend/src/applicationForm.js`), only for convenience; the server checks everything again (`backend/utils/applicationForm.js`). The two are written separately, so a script runs the same inputs through both and requires **identical field paths, codes and limits**. It needs no server or database:

```bash
cd frontend
npm run check:form-rules
```

It covers 19 inputs (valid, every kind of error, values exactly at each limit, several mistakes at once), compares the limits and the credit maximum per system, and checks that an "Other" credit-system name sent with ECTS is not stored and that the form sends credits as numbers.

| Date | Result |
|---|---|
| 2026-10-28 | **23 passed, 0 failed**: all 19 inputs identical in browser and server |
| 2026-10-29 | **46 passed, 0 failed**: also the syllabus rule (8 cases), one PTE course, and the file rules (9 files, sizes, download names) identical in browser and server |
| 2026-10-29 | **70 passed, 0 failed**: also the blocking statuses and course-code matching (Group 6), note counting (emoji, accents, Hungarian letters) and its verdicts (Group 7), and drafts: a draft comes back exactly as saved, files the server removes are removed in the form too, an odd draft can never break the form, same 200 KB limit |

## 1c. Background jobs: reminders and automatic rejections

The backend runs its background jobs itself (`backend/jobs/`): once at startup, then every 5 minutes. Nothing is kept in memory, and every change is one database update that only applies while its condition still holds, so a restart or a second backend process can't send or reject anything twice. Tests with a fake clock:

```bash
cd backend
npm test
```

They use the database from `backend/.env` (run `npm run migrate` first). They add their own test applications, limit every job run to those (real applications are never touched), use a fake clock 60 days ahead, send no emails (a fake records them) and delete their applications at the end.

| Test | Checks |
|---|---|
| Deadline across a clock change | 23:59:59 Budapest time on the third day, for requests the day before winter and summer time, and late in the evening |
| One reminder | none 25 hours before the deadline; one 23 hours before, carrying the deadline; none on later runs |
| Rejection at the deadline | not one second before; at the deadline: rejected, note "No response to information request.", decided by nobody (System), deadline cleared, history entry `auto_rejected` / `system` / `NO_INFO_RESPONSE` at the run's time, one status email with the reason code; nothing more on a later run |
| After a reply | nothing happens |
| Two runs at the same moment | each application rejected once, one history entry each, one email each in total |
| A failed email | the rejection stays; the next application's email is still sent |
| A full run | reminder and rejection steps together |

| Date | Result |
|---|---|
| 2026-10-30 | **7 passed, 0 failed** (throwaway copy with migration 007) |
| 2026-10-30 | **12 passed, 0 failed** (throwaway copy with migration 008): the 7 above and the 5 semester tests below |

**Semesters** (`backend/tests/semesterJobs.test.js`): a test semester in 2099 that ends on the day winter time starts (25 Oct 2099), with its own applications; two students' drafts are put back afterwards.

| Test | Checks |
|---|---|
| Application period, to the second | opens 1 Sep 00:00 Budapest (31 Aug 22:00 UTC); last 7 days from 24 Sep; last second 30 Sep 23:59:59; then period over |
| Semester end on the clock-change day | last second "period over"; at 26 Oct 00:00 Budapest = 25 Oct 23:00 UTC (already winter time) "between semesters" |
| At the semester end | not one second before; then pending and needs-info rejected as System with `SEMESTER_ENDED`, deadline cleared, one history entry and one email each; approved untouched; a draft saved during the semester deleted, one saved after the end kept |
| Running again, and after a restart (job module loaded fresh) | nothing more happens |
| Two runs at the same moment | each application closed once |

## 1d. Translations: complete, used and consistent

```bash
cd frontend
npm run check:translations
```

Needs no server or database. It reports:
- keys missing in `en.json`, `hu.json` or `de.json`
- `{{placeholders}}` that differ between the languages
- unused keys (keys built at run time count through their prefix, plural forms through their base key, `errors.CODE` through the code appearing in the backend)
- hard-coded English in the student's screens and the pages before login (18 files): visible text, `alert()`/`confirm()` with fixed text, `aria-label`, `title`, `placeholder`, `alt`, `t('key', 'English fallback')`, and showing the server's English `data.message`
- student email templates that don't have the same parts in HU, EN and DE

| Date | Result |
|---|---|
| 2026-10-30, first run | 37 problems: 32 unused keys, 4 hard-coded texts in the reply window, emails not comparable |
| 2026-10-30, after the fixes | **all clear**: 435 keys in EN/HU/DE with matching placeholders, none unused, no hard-coded English in 18 files, emails in HU/EN/DE |

It can't judge whether a translation is good: every new or changed HU and DE text of Groups 3 and 10 is listed for review in [TRANSLATION_REVIEW.md](TRANSLATION_REVIEW.md), with the terms that must stay the same.

**Term book with Group 4 data**
**Term book with Group 4 data** (one-time test on a throwaway copy of the database): an application with a 160-character course name, ECTS credits 7.5, a grade "1,3 (sehr gut)" and an image as evidence was submitted and the term book built with the real code. The book contained the course name (wrapped onto several lines, never past the right margin), code, credits, grade, target course and the embedded image. Institutions, countries and grading documents are not in the term book yet: planned for the admin round (see [PLANNED.md](PLANNED.md)).

---

## Rate limiting (public routes that send email)

| Route | Limit (per hour) | Over the limit |
|---|---|---|
| Forgot password, per address | 3 (`RATE_LIMIT_FORGOT_PER_EMAIL`) | Same `200` reply, no email |
| Forgot password, per IP | 30 (`RATE_LIMIT_FORGOT_PER_IP`) | Same `200` reply, no email |
| Register, per IP (failed attempts count too) | 30 (`RATE_LIMIT_REGISTER_PER_IP`) | `429 TOO_MANY_REQUESTS`, no account created |

How it works:
- **Every request counts for its address**, whether or not an account exists. Known and unknown addresses go through the same steps before the reply, so neither the answer nor its timing reveals an account.
- **Addresses are lower-cased and trimmed** before counting, so `A@x.hu ` and `a@x.hu` share one count.
- **Counts are stored in PostgreSQL** (table `rate_limit_hits`, created at startup), so they survive a server restart and are shared by all backend processes. Rows older than one hour are deleted.
- **No plain addresses or IPs are stored**, only an HMAC of them. The HMAC key is derived from `JWT_SECRET`, so **changing `JWT_SECRET` resets all counts**.
- **Check and insert run in one transaction** under a lock on that address/IP, so simultaneous requests cannot exceed a limit.
- **Only allowed requests are counted.** Refused ones do not extend a block, so the hour always ends.
- **Behind a reverse proxy**, set `TRUST_PROXY` to the number of proxies (e.g. `1`), never `true`. Express then uses the address the proxy added and ignores anything a client wrote into `X-Forwarded-For`. The server refuses to start with `true` or any other non-number.
- **Any future public route that sends email** (e.g. "resend verification") must use the same limiter (`takeSlot` in `backend/utils/rateLimit.js`).
- **Keep the limits the same for the server and the script.** The script reads the limits from `backend/.env`; if the server runs with different values, section 8 will fail.

---

## 2. Browser checklist

Run with both servers started (`backend`: `node server.js`, `frontend`: `npm start`) and the app opened at `http://localhost:3000`.

| # | Test | Steps | Expected |
|---|---|---|---|
| B1 | Dashboard needs a login | Log out, type `/dashboard` in the address bar | Login page, no message |
| B2 | Expired session | Logged in, DevTools console: `localStorage.setItem('token', localStorage.getItem('token').replace(/\.[^.]+\./, '.eyJpZCI6MSwicm9sZSI6InN0dWRlbnQiLCJleHAiOjF9.'))`, then reload | Login page with "Your session expired…" |
| B3 | Inactivity logout | Log in, leave the tab untouched for 30 minutes | Sent to login with the expiry message |
| B4 | Active user stays logged in | Keep using the app for more than 30 minutes | No logout (token renewed in the background) |
| B5 | Wrong password | Log in with a wrong password | Error on the page, no redirect |
| B6 | Logged-in user on login/register | While logged in, open `/login` and `/register` | Redirected to the dashboard, no loop |
| B7 | Unknown address | Open `/abc` | Login page (or the dashboard when logged in) |
| B8 | Faked role in the browser | As a student, set `role = superadmin`, `originalRole = superadmin`, `impersonatedRole = reviewer`, `impersonatedUserId = 2` in Local Storage, reload | Still the student's own dashboard; the impersonation keys are removed |
| B9 | Real impersonation | As superadmin, impersonate a student, then try Submit | Student's applications shown; Submit shows "You are not allowed to do this." and does not log out |
| B10 | Fake login message | Open `/login?reason=FILES_NOT_OWNED`, then `/login?reason=SESSION_TOO_OLD` | No message for the first; the 8-hour message for the second |
| B11 | Email links with an old session | Make the token expire (B2), then open a reset or verify link from the email | The page works; no redirect to login |
| B12 | Evidence file download (reviewer) | Reviewer: Open and Download a student's PDF and image | Opens in a new tab / saves with its name |
| B13 | Term book download (admin) | Superadmin → Term Archive: generate a book, then Download | PDF saves with its name and opens |
| B14 | Evidence is private | Copy a file name and open `http://localhost:9000/transcripts/<file name>` | Access denied (the bucket is private) |

**Group 2: programmes** (test accounts from `npm run seed:dev`, password `Test1234!`)

| # | Test | Steps | Expected |
|---|---|---|---|
| B15 | Student fields follow the email | Register: type `anna@tr.pte.hu`, then `anna@mik.pte.hu`, then back | Neptun code and programme appear, disappear, and come back **empty** |
| B16 | Neptun code input | Type `abc 123`; paste ` cvtst1 ` | Shows `ABC123` / `CVTST1`; no error while typing |
| B17 | Neptun check on leaving the field | Type `abc12`, click elsewhere | "Enter a valid Neptun code…" under the field |
| B18 | Programme names follow the language | Switch EN / HU / DE on the register page | Computer Science Engineering / Mérnökinformatikus / Ingenieurinformatik |
| B19 | Inline registration errors | Register with Neptun `CSTST1`; then with email `student.cs@tr.pte.hu`; then without a programme | Error under the Neptun field / under the email / under the programme (no request sent for the last) |
| B20 | Profile header | Log in as `student.cs@tr.pte.hu` | Name, email, Neptun code `CSTST1`, programme next to Logout, in the current language |
| B21 | No stale profile | Log out, log in as `student.civil@tr.pte.hu` in the same tab | Only the Civil student's details, never the previous student's, not even briefly |
| B22 | No profile for staff / impersonation | Log in as a reviewer and as admin; impersonate a student | No profile card |
| B23 | Course picker by programme | As `student.cs` and as `student.civil`, open the submit tab | 12 CS courses / 5 Civil courses, never the other programme's |
| B24 | No courses yet | Delete the Civil courses (`DELETE FROM courses WHERE programme_id = …`), open the submit tab as `student.civil`; then `npm run seed:dev` | "No courses are available for your programme yet." and Submit disabled |
| B25 | Submit sends ids only | Submit as `student.cs` with two courses, watch DevTools → Network | Body has `target_course_ids`, no `student_id` or `pte_course_names`; application appears with both courses |
| B26 | Course removed while the page is open | Choose CS305 and CS101, delete CS305 in the database, press Submit; then `npm run seed:dev` | "…not part of your programme… Removed from your choice: CS305."; CS101 stays chosen |

**Group 4: application form** (as `student.cs@tr.pte.hu`, submit tab; check the errors in EN, HU and DE)

| # | Test | Steps | Expected |
|---|---|---|---|
| B27 | Institutions | Add a second institution, give both a name and country | Course rows list them as "Name (Country)", so same-named institutions can be told apart |
| B28 | Remove an institution | Remove an unused one; then one that a course uses | Unused: removed at once. Used: "1 course uses this institution. Remove it anyway?"; OK clears only that row's institution choice |
| B29 | Institution limit | Add institutions until there are 10 | Button greyed out with "Maximum 10 institutions" |
| B30 | Grading document once per institution | Upload, open, replace, remove; then remove an institution that has one | Translated "Upload document" / "Replace document" buttons; the file is replaced, removed, and deleted with its institution |
| B31 | Remove a course row | Remove an empty row; a typed row; a row with evidence; try the last row | Empty: at once. Typed: "Remove this course?". With evidence: warns that the evidence is deleted. The last row has no remove button |
| B32 | Course row limit | Add rows until there are 20 | Button greyed out with "Maximum 20 courses" |
| B33 | Credit system | New row; choose "Other"; switch back | Starts on "Choose the credit system"; "Other" shows a name field that disappears again |
| B34 | Credit comparison | All rows ECTS; then one row US credit hours | ✅ and evidence note as before; then "Different credit systems: the reviewer will compare the credits." |
| B35 | Empty submit | Press Submit on the empty form | An error under every required field, "No evidence uploaded for this course" next to the evidence button, "Please correct the 11 marked fields." under Submit, first field focused, **no request sent** |
| B36 | Leaving a field | Tab through the empty form; then type 60.5 in ECTS credits and leave | No errors while tabbing; then "…at most 60, in steps of 0.5." |
| B37 | Errors clear | Fix a marked field; change a credit system; upload evidence | Its error disappears and the count under Submit goes down |
| B38 | Duplicate and unused | Two "TU Wien (Austria)" both used; an institution no course uses | "This institution is already in the list." / "No course is linked to this institution…" under the name |
| B39 | Screen reader | VoiceOver on (Cmd+F5), press Submit on the empty form | "Please correct the … marked fields." is announced |
| B40 | Reviewer screen and term book | Submit a complete application; open it as `reviewer.cs@mik.pte.hu`; as admin generate a term book for today and open the PDF | The reviewer screen shows course name, credits, grade and evidence as before; the term book shows the application and long course names wrap inside the page |

**Group 5: evidence and file rules** (as `student.cs@tr.pte.hu`; test PDFs of 6, 12 and 31 pages help)

| # | Test | Steps | Expected |
|---|---|---|---|
| B41 | PDF opens | Upload a transcript PDF on a course row | Opens sharp in the highlighter, no "could not load" alert; no request to cdnjs (the PDF engine is part of the app) |
| B42 | Highlighter | Drag across a line; cross it twice; erase; "Clear highlights on this page" | See-through yellow, text readable, overlaps not darker; eraser only removes yellow |
| B43 | Touch and resize | Highlight with a finger (phone/tablet); resize the window | Draws without scrolling the page; marks stay on the same text |
| B44 | Highlight required | Save without highlighting; then tap once and save; then highlight and erase everything and save | "Highlight this course's line on the transcript before saving." each time; a real stroke allows saving |
| B45 | Saved PDF | Open the saved file; check it in Chrome, Firefox and Adobe Reader | Page 1 plus highlighted pages; "Original page X of Y" below each page, not over the footer; yellow looks right in all three |
| B46 | Page navigation | Open a 12-page syllabus; highlight pages 3 and 7; move back and forth | "Page X of Y"; marks kept; "Pages that will be saved: 1, 3, 7" |
| B47 | Page limits | A 6-page transcript; a 31-page syllabus | Refused with the transcript / syllabus message |
| B48 | Photos | Highlight a JPG photo and a PNG screenshot | Saved as .jpg / .png, sharp |
| B49 | Syllabus rule | One PTE course; credits lower; then US credit hours; then two fulfilled courses | The syllabus box appears with the matching reasons and one upload per course; "✓ Syllabi attached" when all are uploaded |
| B50 | File rules | A Word file; a text file renamed .pdf; a 60 MB PDF for a transcript; an 11 MB grading document | "Only PDF, JPG and PNG files can be uploaded." / same / "…maximum is 50 MB." / "…maximum is 10 MB.", shown at that upload |
| B51 | Original names | Upload "tantárgyleírás.pdf"; as reviewer, Download it | The form shows the original name; the download is saved as "tantárgyleírás (highlighted).pdf" with accents |
| B52 | Add missing info | In the resubmit window, save a PDF letter without highlights; then a highlighted one | Without highlights the whole original is uploaded unchanged; with highlights the highlighted version |
| B53 | Reviewer | Open a Group 5 application as `reviewer.cs` | 📄 icon for PDF transcripts (no broken image); the syllabus under each course with Open and Download |

**Groups 6 and 7: target courses, duplicates and submitting** (run `npm run migrate` in `backend/` and restart the backend first; as `student.cs@tr.pte.hu`, check texts in EN, HU and DE)

| # | Test | Steps | Expected |
|---|---|---|---|
| B54 | Applied courses in the picker | Submit an application for a course; open the submit tab again | That course is greyed out with "— already applied (under review)"; after the reviewer approves it, "— already approved" |
| B55 | Rejected course can be chosen again | As `reviewer.cs`, reject the application; reload as the student | The course can be chosen again |
| B56 | Duplicate from another tab | Open the submit tab in two tabs; submit the same course in both | The second shows "There is already an active or approved application for this PTE course." under the course picker, and the picker greys it out |
| B57 | Note counter | Type into the note; paste 2001 characters; type emoji | "… / 2000 characters"; near the limit "… characters left", over it "… characters over the limit", and Submit reports it under the note; an emoji counts as 1 |
| B58 | Note counter with a screen reader | VoiceOver on, type until fewer than 200 characters are left | Announced at 200, 100 and 50 left, at 0 and when over, not at every key |
| B59 | Confirmation summary | Fill a complete form, press Submit | Dialog with the target course, institutions and grading documents, courses (credits, grade, files), syllabus reasons and the note; focus on its heading; keyboard stays inside |
| B60 | Back to edit | Press "Back to edit", then Esc on a reopened dialog | Dialog closes, nothing sent, focus back on Submit |
| B61 | Confirm and submit | Press "Confirm and submit" | Sent once (buttons disabled while sending); "My Status" opens with "Submitted successfully!" at the top, read out by the screen reader, closed with ×; no browser pop-up |
| B62 | Refused after confirming | Close submissions as admin with the dialog open, then confirm | Dialog closes; the error is shown under Submit |
| B63 | Draft saved | Type in the form, wait 3 seconds | "Draft saved 14:32" above Submit (in the current language's time format) |
| B64 | Draft restored | Close the tab and log in again (also in another browser) | Form filled in as left, with "Your unsent application was restored (last saved …)" at the top; file names shown with their original names |
| B65 | Draft on leaving | Type, then close the tab within 3 seconds; log in again | The last change is there |
| B66 | Draft before idle logout | Type, then leave the tab untouched until logged out (30 minutes) | After logging in again, the form is restored |
| B67 | Draft with a removed file | Upload a transcript, wait for "Draft saved", delete the file in MinIO, reload | "1 file from the draft is no longer available…"; the row asks for the evidence again |
| B68 | Draft after submit | Submit; open the submit tab again; reload | Empty form, no "restored" notice |
| B69 | Old draft format | In the database set `UPDATE application_drafts SET version = 0`, reload | "…made with an older version of this form and could not be restored."; empty form |
| B70 | Draft not loading | Stop the backend, reload the dashboard, start the backend | "Your saved draft could not be loaded. Autosave is paused…"; reloading restores it |
| B71 | No drafts while impersonating | As admin, impersonate a student and open the submit tab | No draft status, no "not allowed" banner, the student's draft unchanged |

**My Status (Group 8):** run `npm run migrate` (007) and restart the backend first. Emails arrive in the Mailtrap sandbox.

| # | What | How | Expected |
|---|---|---|---|
| B72 | Status labels | Look at applications in each status; switch to HU and DE | "Under review", "Information needed", "Approved", "Rejected", "Withdrawn" (translated); never "Locked" or a raw code like `needs_info` |
| B73 | Table | Open My Status | One row per application: PTE course (code, name, credits), status, submission date, "What next", Details |
| B74 | Dates in Budapest time | Set the computer to another time zone (e.g. New York), reload | Dates unchanged (Budapest time), in the chosen language |
| B75 | Long reviewer note | Reviewer requests information with a very long note | The note wraps, shows at most 4 lines in the table, no sideways scrolling; the full note is in Details |
| B76 | Phone width | Make the window narrower than 640 px (or use a phone) | Each application becomes a card, each value with its column name above it |
| B77 | Empty state | Log in as a student without applications | "No applications submitted yet." and **Start a new request**, which opens the submit tab |
| B78 | Detail view with the keyboard | Tab to **Details**, press Enter; Tab through; press Esc | Opens with focus on the heading; focus stays inside; Esc closes, focus back on that Details button |
| B79 | Detail contents | Open Details of a complete application | Institutions with grading document, courses with institution, credits, grade, transcript and syllabus (open in a new tab, original file names), syllabus reasons if any |
| B80 | History | Reviewer requests information, student replies with a file, reviewer decides; open Details | In order: Application submitted (You), More information requested (Reviewer) with the note, Information added (You) with the note and the file, Status changed to … (Reviewer) |
| B81 | Resubmitted marker | After a reply; after a second round | "Resubmitted on …"; "Resubmitted 2 times, last on …" |
| B82 | Admin decision | As admin, change an application's status | Detail: "Last status change: Admin, …"; the reviewer's note is still there (no "System Override") |
| B83 | Older application | Open Details of an application from before migration 007 | History with dates only and "Rebuilt from older records…" |
| B84 | Withdraw: keep | Details of a pending application → **Withdraw application** → **Keep application** | Question shown with focus on it; Keep returns, focus on the Withdraw button, nothing changed |
| B85 | Withdraw | Details → Withdraw application → **Withdraw** | Window closes; "Your application was withdrawn." at the top (focused); status "Withdrawn"; email "You withdrew your credit transfer application" in the student's language |
| B86 | Withdrawn for the reviewer | Log in as `reviewer.cs` | The application is in none of the tabs |
| B87 | Reviewer acts on a withdrawn one | Open the reviewer page; the student withdraws in another browser; the reviewer then approves it | "The student has withdrawn this application, so it can no longer be changed."; nothing changed |
| B88 | Apply again | After withdrawing, open the submit tab | The course can be chosen again |
| B89 | No withdraw | Details of an approved or rejected application; any application while impersonating | No Withdraw button |

**The needs-info loop (Group 9):** the SQL lines are run with `docker exec -it credit_system_db psql -U user -d credit_db`; replace `<id>` with the application's id.

| # | What | How | Expected |
|---|---|---|---|
| B90 | Deadline shown | As reviewer, request information | Table, Details and the "Add Missing Info" window show "Respond by 2 November 2026, 23:59" (3 days later, 23:59), translated |
| B91 | Deadline in the email | Open the needs-info email | "Please reply by 2 November 2026, 23:59 (Budapest time)…", in the student's saved language |
| B92 | Less than a day left | `UPDATE applications SET info_deadline = now() + interval '5 hours' WHERE id = <id>;` then reload | Red warning "Less than a day left to respond." |
| B93 | Deadline passed (before the job runs) | Start the backend with `JOBS_DISABLED=1 node server.js`; `UPDATE applications SET info_deadline = now() - interval '1 minute' WHERE id = <id>;` reload | "The deadline for replying has passed…"; no Add Missing Info button. A reply sent from a tab opened earlier: "The deadline for replying has passed…" |
| B94 | Reminder | `UPDATE applications SET info_deadline = now() + interval '20 hours', info_reminder_sent_at = NULL WHERE id = <id>;` then restart the backend (normally, without `JOBS_DISABLED`) | One reminder email ("Reminder: please reply about your application by tomorrow") with the deadline, in the student's language; restarting again sends no second one |
| B95 | Automatic rejection | `UPDATE applications SET info_deadline = now() - interval '1 minute' WHERE id = <id>;` then restart the backend | Status "Rejected"; note "No response to information request." (translated in HU/DE); Details: "Last status change: System", history "Rejected automatically · System"; email with "Reason: No response to information request."; the reviewer sees it under Completed |
| B96 | Reply while submissions are closed | As admin, close submissions; as the student, reply to an information request | Accepted; back to "Under review" |
| B97 | Jobs switched off | Start the backend with `JOBS_DISABLED=1 node server.js` | Warning "Background jobs are switched off" in the terminal |

**Semesters (Group 3):** run `npm run migrate` (008) and `npm run seed:dev` (creates the development semester) first, and restart the backend. The SQL lines change the current semester's days relative to today; `<id>` is its id (`SELECT id, name FROM semesters;`). Put the original days back afterwards (or run `npm run reset:dev -- --yes`, `npm run migrate`, `npm run seed:dev`). **B104–B106 close applications for real: use test accounts.**

| # | What | How | Expected |
|---|---|---|---|
| B98 | Not started yet | `UPDATE semesters SET applications_open_on = current_date + 10, applications_close_on = current_date + 20, ends_on = current_date + 40 WHERE id = <id>;` reload the submit tab | Red banner "The application period has not started yet. You can apply from …" (date in the chosen language); Submit disabled; above Submit "Autosave is off while applications cannot be submitted."; typing and reloading restores nothing new |
| B99 | Open | `… applications_open_on = current_date - 10, applications_close_on = current_date + 20, ends_on = current_date + 40 …` | No banner; "Draft saved …" after typing |
| B100 | Last 7 days | `… applications_close_on = current_date + 3 …` | Orange banner "The application period ends on … Applications not reviewed by … are closed automatically." with both dates; submitting works |
| B101 | Period over | `… applications_open_on = current_date - 20, applications_close_on = current_date - 1, ends_on = current_date + 40 …` | Red banner "No open application period. The last day to apply was …"; no autosave |
| B102 | Closed by admin while typing | Days as in B99; open the submit tab and type; as admin (other browser) close submissions; type again | Within a few seconds: "Submissions are currently closed. Please check back later." at the top; autosave stops; no error |
| B103 | Between semesters | Start the backend with `JOBS_DISABLED=1 node server.js`; `… ends_on = current_date - 1, applications_close_on = current_date - 2, applications_open_on = current_date - 20 …` | "No open application period."; no courses in the picker. Put the days back **before** starting the backend normally (otherwise the job closes the semester) |
| B104 | Semester end | With a test student's pending and needs-info applications and a draft: days as in B103, then restart the backend normally | Both applications "Rejected" with "Not reviewed before the semester closed." (translated); Details: "Last status change: System", history "Rejected automatically · System"; status email with "Reason: …" in the student's language; the draft is gone; the term book lists them as "Not reviewed before semester close" |
| B105 | New semester | `npm run semester:create -- --name "Test semester" --apply-from <today> --apply-until <in 30 days> --ends <in 90 days>`; copy the courses: `INSERT INTO courses (university_id, programme_id, course_code, course_name, credits, semester_id) SELECT university_id, programme_id, course_code, course_name, credits, <new id> FROM courses WHERE semester_id = <old id>;` | My Status: "No applications in this semester yet." and a closed **Previous semesters (n)**; opened, the earlier applications under their semester's name, read-only (Details without Withdraw or reply) |
| B106 | Approved earlier | Before B104, have the reviewer approve one test application; after B105 open the course picker | That course greyed out "— already approved"; a course rejected earlier can be chosen |
| B107 | Reply after the semester end | With `JOBS_DISABLED=1`, end the semester of a needs-info application (as B103) and reply from a tab opened before | "The semester has ended, so the application can no longer be changed." |

**Translations (Group 10):**

| # | What | How | Expected |
|---|---|---|---|
| B108 | No English left | Switch to HU, then DE; go through login, register, forgot password, reset password, verify page, the form (banners, reply window labels and placeholder), My Status, Details, withdraw | Every text in the chosen language; German says "Gutachter", Hungarian "PTE-kurzus" |
| B109 | No pop-ups | Reply with no note and no file; send a reply; open a file that no longer exists | Message under the note; "Your reply was sent to the reviewer." at the top of My Status; the error in the status line; no browser pop-up |
| B110 | Verification email | Register once with HU selected, once with DE | The verification email in Hungarian / German |
| B111 | Password reset email | Forgot password for a student whose saved language is DE | The reset email in German; the page shows its own translated confirmation |
| B112 | Highlighter messages | Open a copy-protected PDF, a PDF over the page limit and a damaged file in the highlighter | Messages on the page in the chosen language; no browser pop-up |

**Full student walkthrough, once per language (EN, HU, DE):** switch the language on the login page first, and check that nothing on any screen or in any email is in another language.

| # | Step | Expected |
|---|---|---|
| B113 | Register a new student (name, university email, Neptun code, programme) | "Registration Complete" page; verification email in the chosen language |
| B114 | Open the link in the email; log in | Account verified; My Status empty with "Start a new request" |
| B115 | Submit: institution with grading document, a course with highlighted transcript (and syllabus if asked), the target course, a note; Submit, check the summary, confirm | Summary lists everything; My Status "Under review" with the submission date; "submitted" email |
| B116 | As `reviewer.<programme>`, request information with a note | My Status "Information needed", the note and "Respond by …"; needs-info email with the deadline |
| B117 | Reply with a note and a highlighted file | "Your reply was sent to the reviewer."; "Under review" with "Resubmitted on …"; Details shows the request and the reply in order |
| B118 | Reviewer approves (or rejects) | Status updated; status email; Details: "Last status change: Reviewer, …" |
| B119 | Submit a second application for another course and withdraw it | Withdraw question, then "Your application was withdrawn."; status "Withdrawn"; withdrawn email |

---

## 3. Pending for the reviewer round

Every application now records its programme (Group 2), so the data supports these checks. The filtering itself is built in the reviewer round.

| Test | Expected | Status |
|---|---|---|
| A reviewer cannot see another programme's applications (list, single application, evidence files) | `403` / filtered list | **Pending (reviewer round).** Today every reviewer can see every application. |
| The reviewer screen shows institution, country, credit system and grading document | shown, files opened only by staff | **Pending (reviewer round).** The data is stored since Group 4. |
| The term book includes institutions, countries and grading documents | included | **Pending (admin round).** |

---

### Evidence highlighter (Group 5)

The highlighter's rules are tested in Node (`frontend/src/highlighter.js`), with real PDFs:

| What | Result |
|---|---|
| Saved PDF | page 1 plus every highlighted page, in order; original pages copied unchanged (text still searchable); "Original page X of Y" in a strip **added below** each page, never over it |
| Copy-protected PDF | opens; saved from the rendered page images instead, so the student is never blocked |
| Page limits | transcript 5 pages, syllabus 30 (longer PDFs refused when opened, never cut) |
| Minimum highlight | clearly painted area of at least 0.03% of the page (a short stroke). A single tap, a stroke erased completely, and faint erasing leftovers do not count; the same on a 2× PDF page and a capped photo |

**The highlight rule is checked in the browser only.** The server cannot see highlights: they are pixels inside an image or PDF. Someone building requests by hand could upload an unhighlighted transcript or syllabus. The reviewer still sees the file and judges it; the rule exists to guide students, not as access control.

---

## 4. Known limitations

- **CORS is a browser rule.** It stops other websites from reading API answers in a user's browser. It does not stop direct requests (curl, scripts); those are protected by the login token and role checks above.
- **Register reveals registered addresses and Neptun codes.** Signing up with an address that already has an account answers `400 EMAIL_TAKEN` ("Email already registered"), and a Neptun code that is already used answers `400 NEPTUN_TAKEN`, so anyone can check whether an address or Neptun code is registered. Closing this would mean always answering "check your inbox" and emailing the existing account owner instead; not done yet.
- **Someone can use up another person's reset emails.** Sending 3 forgot-password requests for a classmate's address blocks reset emails to that address for up to one hour. This is the unavoidable trade-off of a per-address limit; the block always ends after an hour.
- **Shared IPs.** A whole campus can share one IP (eduroam, computer labs). That is why the per-IP limits are generous (30 per hour); they can be changed in `.env`.
- ~~Forgot password timing~~ **(fixed 2026-10-28).** A real address used to take about 1.9 s longer than an unknown one, because the email was sent before replying. The reply now comes straight after the lookup in both cases (see section 1).
- **Older evidence files without an owner tag.** A few files uploaded before ownership tagging can be opened by reviewers and the superadmin, but not by the student who uploaded them. No other student can open them either.
- **Impersonation shows every programme's courses.** While the superadmin impersonates a student, the course picker uses the admin's token, so it lists the courses of all programmes, not only that student's. Submitting is refused during impersonation anyway. To be fixed in the admin round.
- **Highlights are not verified by the server** (see "Evidence highlighter" above).
- **Uploads from forms that are never submitted stay in storage** until a cleanup job exists (see [PLANNED.md](PLANNED.md)).
- **Drafts: the last save wins.** With the form open in two tabs or browsers, each saves its own state; the later save replaces the other. Opening the form again shows the last saved state. A tab left open after a submit can also save the submitted form again as a draft; submitting it a second time is refused with `ALREADY_APPLIED`. A conflict check is planned (see [PLANNED.md](PLANNED.md)).
- **Drafts are readable by the student only, not encrypted.** They are stored in the database as JSON, like the applications themselves.
- **A failed reminder email is not sent again.** The reminder is recorded before it is sent, so it can never go out twice; if that one email fails, the student still has the needs-info email and the deadline on screen.
- **Automatic rejection can come up to 5 minutes after the deadline**, because the job runs every 5 minutes. Replies are refused exactly at the deadline, so nothing can arrive in between.
- **History rebuilt by migration 007 is incomplete.** For applications from before Group 8, only the latest note of each kind and the closest recorded time were still known; those entries are marked as rebuilt.
- **Withdrawing cannot be undone.** The student can submit a new application for the same course instead.
- **Applications from before semesters are never closed automatically.** Applications without a semester (submitted before migration 008, outside any semester's dates) stay as they are at a semester end; a new semester takes in only those submitted during its dates.
- **A semester end is processed up to 5 minutes after midnight**, because the job runs every 5 minutes. Submitting already stops when the application period ends, and replies are refused from the semester end on.
- **"Between semesters" is not tested through the API**, because producing it would end the real current semester; it is tested with a fake clock (section 1c).
- **A new semester has no courses until they are imported** (Neptun CSV import, admin round). `npm run semester:create` only takes in courses that have no semester; the browser checklist copies them with SQL.
- **Files of earlier semesters are kept indefinitely.** How long to keep them is to be confirmed with the institution (see [PLANNED.md](PLANNED.md)).
- **The reviewer and admin screens still have English texts and pop-ups.** The translation check looks for hard-coded English only in the student's screens and the pages before login; the reviewer and admin rounds will widen it.
- **Front-end checks are not security.** The route guards and role checks in the browser only decide which screens to show; the backend checks every request itself (sections 1–7).
