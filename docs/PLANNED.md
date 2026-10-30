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
- **Course import from Neptun CSV** per programme at semester start, into that semester (`courses.semester_id`, Group 3). Courses are seeded until then; a new semester has no courses until they are imported.
- **Semesters on the admin screen.** Today they are created with `npm run semester:create` (Group 3): an admin screen to create, view and correct semesters (application period, end), with the same checks (real days, in order, no overlaps).
- **Term book per semester.** The term book is built for a date range; with semesters it can be built for a semester, including the applications closed at its end ("Not reviewed before semester close").
- **Translate the reviewer and admin screens.** Their pop-ups and some texts are still English; `npm run check:translations` (Group 10) checks hard-coded English only in the student's screens; add the reviewer and admin files to its list once they are translated.
- **Move the admin dashboard and term archive to the shared ky client.**
- Settings toggle accepts any value for "open"; should refuse anything but true/false (`INVALID_SETTING`).
- Role-management confirmation texts are still English.

## After the reviewer and admin rounds

- **Drop `applications.pte_course_names`.** It is a text copy of `target_courses`, kept only because the reviewer screen, admin screen and term book still read it.
- **Read notes from the history only.** `reviewer_note`, `student_resubmit_note` and `supplemental_files` duplicate what `application_events` records (Group 8), keeping only the latest of each. Once the reviewer screen, admin screen and term book read the history, they can be dropped.

## Group 3 (done)

- ~~Semesters and the application window~~ **(done):** migration 008, `npm run semester:create`, one submission state for submit, drafts and the form banner.
- ~~Clear drafts at semester end~~ **(done):** the semester-end job step deletes drafts last saved before the end.
- ~~Previous semesters in My Status (item 33)~~ **(done):** a read-only "Previous semesters" section grouped by semester.
- ~~Semester-end automatic rejection~~ **(done):** `SEMESTER_ENDED`, by System, with the status email.
- ~~History across semesters for the duplicate rule~~ **(done):** applications are never deleted, so the existing rule (and migration 005's index) already covers every semester: an approved course blocks, a rejected one doesn't.
- **How long to keep earlier semesters' files.** Applications and their files are kept read-only with their semester for now. A retention period (and what happens after it: deleting the files, keeping the term book) is to be confirmed with the institution.
- **Reminding students before the semester end.** Unreviewed applications are closed at the semester end; the form warns during the last 7 days of the application period, but no email reminds students (or reviewers) before the end.
- **Applications from before semesters.** Rows without a semester are never closed automatically; once all of them are decided, `applications.semester_id` and `courses.semester_id` can be made NOT NULL.

## Group 5

- **At least one visible highlight per evidence document.**

## Later (student side)

- **Retry a failed reminder email.** The reminder before the reply deadline is recorded before it is sent, so it never goes out twice, but also not again if that email failed. A small "emails to retry" table would allow both.
- **Drafts: conflict check across tabs.** Today the last save wins (documented under "Known limitations" in SECURITY_TESTS.md). A check could send the `updated_at` the tab last saw and, when the server has a newer draft, ask which one to keep.

- **Reusing an institution and its documents** (grading document, transcript) from an earlier application, instead of uploading them again.

## Other

- ~~"Add missing info" window texts are still English~~ **(fixed in Group 10):** the labels and the placeholder come from the locale files. Its PDFs share the 30-page syllabus limit.

- ~~"Evidence required" note is written by the browser~~ **(fixed in Group 5):** the server works out when a syllabus is required, writes `system_note` itself and ignores what the browser sends.
- **Register reveals registered addresses and Neptun codes** (`EMAIL_TAKEN`, `NEPTUN_TAKEN`). Fix: always answer "check your inbox" and email the existing account owner.
- ~~Success messages of forgot / reset password are still English~~ **(fixed in Group 10):** the pages show their own translated texts; the verification and reset emails exist in HU, EN and DE.
- ~~The PDF highlighter shows an untranslated browser alert~~ **(gone by Group 10):** no `alert()` is left in the highlighter; messages are shown on the page (browser checklist B112).
- **German term for the reviewer.** "Gutachter" is used everywhere since Group 10 (it was mixed with "Prüfer"). If "Prüfer" is preferred, see the terms in [TRANSLATION_REVIEW.md](TRANSLATION_REVIEW.md).
- ~~Student "My Status" does not show the reviewer's note or the resubmit information~~ **(fixed in Group 8):** the table shows the reviewer's note and a "Resubmitted" marker; the detail view shows the whole history.
- ~~`db.js` keeps its startup test connection open~~ **(fixed in Group 9):** the connection is given back after the test, so `npm test` ends on its own.
