# Planned work (deferred to later rounds)

Things deliberately left for later while building the student side, with the reason and the round they belong to. Security-related gaps are also listed under "Known limitations" in [SECURITY_TESTS.md](SECURITY_TESTS.md).

## Reviewer round

- **Reviewers only see their own programme's applications** (list, single application, evidence files). Every application already records its programme; the filtering and its test are still to do.
- **One reviewer per programme**, and reviewer registration as a guest with a programme. The registration form currently decides student fields by email domain (`@tr.pte.hu`); that logic changes then.
- **Show the Group 4 data on the reviewer screen:** institution, country, credit system and the grading-system file of each fulfilled course. Until then the screen shows course name, code, credits, grade and evidence as before.
- **One decision and one final PTE grade per application** (each application has exactly one target PTE course since Group 5).
- **Show why a syllabus was required, translated:** the server stores the reasons as codes in `applications.syllabus_reasons` (`CREDIT_GAP`, `CREDIT_SYSTEMS`, `COMBINED_COURSES`); the English `system_note` stays for the term book.
- **Move the reviewer dashboard to the shared ky client** (it still uses the axios bridge, `src/api.js`).
- Reviewer page does not refresh by itself after changes.
- **Rules for allowed status changes.** Today the status route accepts any of pending, needs info, approved and rejected from any status (only "withdrawn" is closed for good, since Group 8). The reviewer round should define which changes are allowed, e.g. no reopening of an approved application without a reason, and refuse the rest with their own error code.
- **Show the history and the reply deadline on the reviewer screen.** Since Group 8 every step is in `application_events` (who, when, note, files of each reply) and a needs-info application has `info_deadline`; the reviewer screen still reads the single note columns, which only hold the latest note.

## Admin round

- **Term book: append highlighted PDF evidence.** Since Group 5 a syllabus is saved as a highlighted PDF (page 1 plus the highlighted pages). pdfkit can only embed images, so the term book lists PDF evidence by name; merging the PDF pages into the book (e.g. with pdf-lib) would show them.
- **Term book: add grading-system files** (`applications.institutions[].grading_file`) and show institution, country and credit system. Today it embeds only each course's evidence file.
- **Impersonation shows every programme's courses** in the student course picker, because the request uses the admin's token. Needs a way for the admin to read the impersonated student's programme. Also no profile card while impersonating.
- **Clean up uploads from forms that are never submitted (after semester end).** Evidence and grading documents are uploaded as soon as they are chosen; if the student never submits, those files belong to no application. Removing a course row, a document or an institution in the form deletes its file. The rest needs a cleanup job after semester end: delete files that no application **and no draft** refers to (a draft keeps its files until it is submitted or cleared).
- **Role change to "student"** needs a Neptun code and programme picker. Until then it is refused with `STUDENT_PROFILE_REQUIRED`.
- **Correcting a student's programme** (students can't change it themselves).
- **Course import from Neptun CSV** per programme at semester start. Courses are seeded until then.
- **Move the admin dashboard and term archive to the shared ky client.**
- Settings toggle accepts any value for "open"; should refuse anything but true/false (`INVALID_SETTING`).
- Role-management confirmation texts are still English.

## After the reviewer and admin rounds

- **Drop `applications.pte_course_names`.** It is a text copy of `target_courses`, kept only because the reviewer screen, admin screen and term book still read it.
- **Read notes from the history only.** `reviewer_note`, `student_resubmit_note` and `supplemental_files` duplicate what `application_events` records (Group 8), keeping only the latest of each. Once the reviewer screen, admin screen and term book read the history, they can be dropped.

## Group 3 (postponed)

- **Semesters and the application window.** Needs a semester model that doesn't exist yet, and one open decision.
- **Clear drafts at semester end.** Drafts (`application_drafts`, Group 7) are kept until the student submits or the account is deleted. When a semester closes, unsent drafts should be deleted (or the students reminded first), so a new semester never starts from an old form.
- **Previous semesters in My Status (Group 8, item 33).** My Status lists every application of the student; with semesters it should group them, or show earlier semesters separately.
- **Semester-end automatic rejection.** The background job of Group 9 (`backend/jobs/applicationJobs.js`) is built for it: `rejectAutomatically()` with the semester-end condition and a new reason code, added to `STEPS`.
- **History across semesters for the duplicate rule.** "One active application per PTE course" (Group 6) reads only the `applications` table. Once semesters exist and old applications are archived, the rule needs a history source across semesters (e.g. approved courses from earlier semesters), so a course approved in an earlier semester still can't be applied for again.

## Group 5

- **At least one visible highlight per evidence document.**

## Later (student side)

- **Retry a failed reminder email.** The reminder before the reply deadline is recorded before it is sent, so it never goes out twice, but also not again if that email failed. A small "emails to retry" table would allow both.
- **Drafts: conflict check across tabs.** Today the last save wins (documented under "Known limitations" in SECURITY_TESTS.md). A check could send the `updated_at` the tab last saw and, when the server has a newer draft, ask which one to keep.

- **Reusing an institution and its documents** (grading document, transcript) from an earlier application, instead of uploading them again.

## Other

- **"Add missing info" window texts:** a few labels there ("Upload …", "Attached New Files") are still English; its PDFs share the 30-page syllabus limit.

- ~~"Evidence required" note is written by the browser~~ **(fixed in Group 5):** the server works out when a syllabus is required, writes `system_note` itself and ignores what the browser sends.
- **Register reveals registered addresses and Neptun codes** (`EMAIL_TAKEN`, `NEPTUN_TAKEN`). Fix: always answer "check your inbox" and email the existing account owner.
- Success messages of forgot / reset password are still English.
- The PDF highlighter shows an untranslated browser alert.
- ~~Student "My Status" does not show the reviewer's note or the resubmit information~~ **(fixed in Group 8):** the table shows the reviewer's note and a "Resubmitted" marker; the detail view shows the whole history.
- ~~`db.js` keeps its startup test connection open~~ **(fixed in Group 9):** the connection is given back after the test, so `npm test` ends on its own.
