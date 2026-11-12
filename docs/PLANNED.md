# Planned work (deferred to later rounds)

Things deliberately left for later, with the reason and the round they belong to. Done items are struck through with the round that finished them. Security-related gaps are also listed under "Known limitations" in [SECURITY_TESTS.md](SECURITY_TESTS.md).

## Reviewer round

- ~~**Reviewers only see their own programme's applications**~~ **(done, reviewer Group 2; round 2: the programmes they can see, main or assisting extra):** lists, details and files, with security-check tests.
- ~~**Show the Group 4 data on the reviewer screen**~~ **(done, reviewer Group 4):** institution, country, credit system and the grading-system file in the details.
- ~~**One decision and one final PTE grade per application**~~ **(done, reviewer Group 6; migration 011 refuses an approval without a grade)**.
- ~~**Show why a syllabus was required, translated**~~ **(done, reviewer round):** the reasons are codes, translated on every screen; the English `system_note` stays for the term book.
- ~~**Move the reviewer dashboard to the shared ky client**~~ **(done, reviewer round)**. Still on the axios bridge (`src/api.js`): the admin's Applications section and the date-range term archive.
- Reviewer page does not refresh by itself after changes.
- ~~**Rules for allowed status changes**~~ **(done, reviewer Group 6, `utils/decisions.js`):** only pending can be decided; approved and rejected are final; the first decision wins (409).
- ~~**Show the history and the reply deadline on the reviewer screen**~~ **(done, reviewer Group 5):** the conversation and the history table come from `application_events`.

## Admin round

- **Term book: append highlighted PDF evidence.** Since Group 5 a syllabus is saved as a highlighted PDF (page 1 plus the highlighted pages). pdfkit can only embed images, so the term book lists PDF evidence by name; merging the PDF pages into the book (e.g. with pdf-lib) would show them.
- **Term book: add grading-system files** (`applications.institutions[].grading_file`) and show institution, country and credit system. Today it embeds only each course's evidence file.
- **Clean up uploads from forms that are never submitted (after semester end).** Evidence and grading documents are uploaded as soon as they are chosen; if the student never submits, those files belong to no application. Removing a course row, a document or an institution in the form deletes its file. The rest needs a cleanup job after semester end: delete files that no application **and no draft** refers to (a draft keeps its files until it is submitted or cleared).
- ~~**Correcting a student's programme**~~ **(done, admin round Group 3).**
- ~~**Course import from Neptun CSV**~~ **(done, admin round Group 4).**
- ~~**Semesters on the admin screen**~~ **(done, admin round Groups 4–6; round 2: review deadline, several semesters in progress, application periods never overlap).**
- ~~**Term book per semester**~~ **(done, admin round Group 6; round 2: the reviewer's book of their programmes, interim while in progress, and one application as a PDF).**
- ~~**Translate the reviewer and admin screens**~~ **(done, admin round Group 8):** `check:translations` checks every screen; `check:missing-keys` lists missing keys.
- **Move the admin's Applications section and the term archive to the shared ky client** (the rest of the admin menu uses it already).
- ~~Settings toggle accepts any value~~ **(gone, admin round Group 5):** the toggle was replaced by the application period (Close now / Reopen until).
- ~~Role-management confirmation texts are still English~~ **(gone, admin round Group 2):** roles are no longer changed; staff are invited.

## After the reviewer and admin rounds

- **Drop `applications.pte_course_names`.** It is a text copy of `target_courses`, kept only because the reviewer screen, admin screen and term book still read it.
- **Read notes from the history only.** `reviewer_note`, `student_resubmit_note` and `supplemental_files` duplicate what `application_events` records (Group 8), keeping only the latest of each. Once the reviewer screen, admin screen and term book read the history, they can be dropped.

## Group 3 (done)

- ~~Semesters and the application window~~ **(done):** migration 008, `npm run semester:create`, one submission state for submit, drafts and the form banner.
- ~~Clear drafts at semester end~~ **(done; since admin round Group 6 the admin's close deletes them; round 2: kept when another application period is open or still to come).**
- ~~Previous semesters in My Status (item 33)~~ **(done):** a read-only "Previous semesters" section grouped by semester.
- ~~Semester-end automatic rejection~~ **(replaced, round 2):** nothing is rejected at the end any more; a semester closes only when everything is decided. Old `SEMESTER_ENDED` records keep their label and text.
- ~~History across semesters for the duplicate rule~~ **(done):** applications are never deleted, so the existing rule (and migration 005's index) already covers every semester: an approved course blocks, a rejected one doesn't.
- **How long to keep earlier semesters' files.** Applications and their files are kept read-only with their semester for now. A retention period (and what happens after it: deleting the files, keeping the term book) is to be confirmed with the institution.
- ~~**Reminding before the end**~~ **(done):** students with an unsent draft are emailed when the last days start (admin round Group 6); reviewers are reminded 7 days and 1 day before the review deadline and get a daily summary (round 2).
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

## Round 2 (Group 1 done)

- ~~Syllabus upload in each course row~~ **(done, Part A).**
- ~~Staff linked to programmes: main and extra reviewers~~ **(done, Part B, migration 019).**
- ~~Sharing work: assisting, assigning, distributing; main reviewer gone~~ **(done, Part C).**
- ~~The timeline: review deadline, several semesters in progress, closing when everything is decided~~ **(done, Part D, migration 020).**
- ~~Reviewer emails: daily summary instead of an email per event~~ **(done, Part E, migration 021).**
- ~~PDFs for reviewers and single-application PDFs~~ **(done, Part F).**
- **Group 2:** committee members (a `committee` role in `staff_programmes`, one CHECK widened) with access to the reviewer's book and the single-application PDF; "and the committee is done" as a close condition.
