# Planned work (deferred to later rounds)

Things deliberately left for later while building the student side, with the reason and the round they belong to. Security-related gaps are also listed under "Known limitations" in [SECURITY_TESTS.md](SECURITY_TESTS.md).

## Reviewer round

- **Reviewers only see their own programme's applications** (list, single application, evidence files). Every application already records its programme; the filtering and its test are still to do.
- **One reviewer per programme**, and reviewer registration as a guest with a programme. The registration form currently decides student fields by email domain (`@tr.pte.hu`); that logic changes then.
- **Show the Group 4 data on the reviewer screen:** institution, country, credit system and the grading-system file of each fulfilled course. Until then the screen shows course name, code, credits, grade and evidence as before.
- **Move the reviewer dashboard to the shared ky client** (it still uses the axios bridge, `src/api.js`).
- Reviewer page does not refresh by itself after changes.

## Admin round

- **Term book: add grading-system files** (`applications.institutions[].grading_file`) and show institution, country and credit system. Today it embeds only each course's evidence file.
- **Impersonation shows every programme's courses** in the student course picker, because the request uses the admin's token. Needs a way for the admin to read the impersonated student's programme. Also no profile card while impersonating.
- **Role change to "student"** needs a Neptun code and programme picker. Until then it is refused with `STUDENT_PROFILE_REQUIRED`.
- **Correcting a student's programme** (students can't change it themselves).
- **Course import from Neptun CSV** per programme at semester start. Courses are seeded until then.
- **Move the admin dashboard and term archive to the shared ky client.**
- Settings toggle accepts any value for "open"; should refuse anything but true/false (`INVALID_SETTING`).
- Role-management confirmation texts are still English.

## After the reviewer and admin rounds

- **Drop `applications.pte_course_names`.** It is a text copy of `target_courses`, kept only because the reviewer screen, admin screen and term book still read it.

## Group 3 (postponed)

- **Semesters and the application window.** Needs a semester model that doesn't exist yet, and one open decision.

## Group 5

- **At least one visible highlight per evidence document.**

## Other

- **Uploads from forms that are never submitted stay in storage.** Evidence and grading documents are uploaded as soon as they are chosen; if the student leaves without submitting, those files are kept but belong to no application. Removing a course row, a document or an institution in the form deletes its file. Cleaning up the rest needs a background job, e.g. deleting files older than a day that no application refers to.
- **"Evidence required" note is written by the browser** (`system_note`, in the student's language) and stored as sent. It should be worked out by the server.
- **Register reveals registered addresses and Neptun codes** (`EMAIL_TAKEN`, `NEPTUN_TAKEN`). Fix: always answer "check your inbox" and email the existing account owner.
- Success messages of forgot / reset password are still English.
- The PDF highlighter shows an untranslated browser alert.
- Student "My Status" does not show the reviewer's note or the resubmit information.
- `db.js` keeps its startup test connection open (harmless for the server; scripts exit explicitly because of it).
