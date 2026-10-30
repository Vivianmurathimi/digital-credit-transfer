# Translation review: Groups 3 and 10

Every HU and DE text that is new or changed in this round, for checking by a native speaker, and the
terms that must stay the same everywhere. The tables below were generated from the locale files
(`frontend/src/locales/*.json`) and the email templates (`backend/utils/emailTemplates.js`), so they
show exactly what the app shows. `{{name}}` parts are filled in by the app (dates in the student's
language, e.g. "2026. november 15." / "15. November 2026").

`npm run check:translations` (in `frontend/`) checks that every key exists in all three languages
with the same placeholders, that no key is unused and that the student's screens contain no
hard-coded English. It cannot check whether a translation is *good*: that is what this list is for.

## Screen texts

| Key | Where | | EN | HU | DE |
|---|---|---|---|---|---|
| `student_no_applications_this_semester` | My Status, empty | new | No applications in this semester yet. | Ebben a félévben még nem nyújtott be kérelmet. | In diesem Semester noch keine Anträge. |
| `student_previous_semesters` | My Status, Previous semesters | new | Previous semesters ({{count}}) | Korábbi félévek ({{count}}) | Frühere Semester ({{count}}) |
| `student_previous_read_only` | My Status, Previous semesters | new | Applications from earlier semesters can only be viewed. | A korábbi félévek kérelmei csak megtekinthetők. | Anträge aus früheren Semestern können nur angesehen werden. |
| `student_before_semesters` | My Status, Previous semesters | new | Before semesters were introduced | A félévek bevezetése előtt | Vor Einführung der Semester |
| `student_reason_SEMESTER_ENDED` | My Status note, history | new | Not reviewed before the semester closed. | A kérelmet a félév lezárásáig nem bírálták el. | Bis zum Semesterende nicht geprüft. |
| `student_reply_label` | Reply window | new | Your reply to the reviewer: | Válasza a bírálónak: | Ihre Antwort an den Gutachter: |
| `student_reply_placeholder` | Reply window | new | Explain what you have updated, or attach new highlighted files below… | Írja le, mit módosított, vagy csatoljon alább új, kiemelt fájlokat… | Erklären Sie, was Sie geändert haben, oder fügen Sie unten neue markierte Dateien hinzu… |
| `student_reply_upload_label` | Reply window | new | Upload additional evidence: | További bizonyíték feltöltése: | Weitere Nachweise hochladen: |
| `student_reply_attached_files` | Reply window | new | Attached new files: | Csatolt új fájlok: | Neu angehängte Dateien: |
| `errors.NO_APPLICATION_PERIOD` | Error message | new | There is no open application period right now. | Jelenleg nincs nyitott jelentkezési időszak. | Derzeit gibt es keinen offenen Antragszeitraum. |
| `errors.APPLICATION_PERIOD_NOT_STARTED` | Error message | new | The application period has not started yet. | A jelentkezési időszak még nem kezdődött el. | Der Antragszeitraum hat noch nicht begonnen. |
| `errors.SEMESTER_ENDED` | Error message | new | The semester has ended, so the application can no longer be changed. | A félév véget ért, ezért a kérelem már nem módosítható. | Das Semester ist beendet, der Antrag kann nicht mehr geändert werden. |
| `student_submissions_closed` | Form banner (19) | new | Submissions are currently closed. Please check back later. | A kérelembeadás jelenleg szünetel. Kérjük, nézzen vissza később. | Anträge können derzeit nicht eingereicht werden. Bitte schauen Sie später wieder vorbei. |
| `student_period_not_started` | Form banner (31) | new | The application period has not started yet. You can apply from {{date}}. | A jelentkezési időszak még nem kezdődött el. Kérelmet ettől a naptól adhat be: {{date}}. | Der Antragszeitraum hat noch nicht begonnen. Anträge sind ab {{date}} möglich. |
| `student_period_none` | Form banner (32) | new | No open application period. | Nincs nyitott jelentkezési időszak. | Kein offener Antragszeitraum. |
| `student_period_over` | Form banner (32) | new | No open application period. The last day to apply was {{date}}. | Nincs nyitott jelentkezési időszak. A kérelembeadás utolsó napja: {{date}}. | Kein offener Antragszeitraum. Der letzte Tag für Anträge war der {{date}}. |
| `student_period_last_days` | Form banner, last 7 days | new | The application period ends on {{closes}}. Applications not reviewed by {{ends}} are closed automatically. | A jelentkezési időszak utolsó napja: {{closes}}. A bírálat határideje: {{ends}}; az addig el nem bírált kérelmeket a rendszer automatikusan lezárja. | Der Antragszeitraum endet am {{closes}}. Anträge, die bis zum {{ends}} nicht geprüft sind, werden automatisch geschlossen. |
| `student_draft_paused_closed` | Status line above Submit | new | Autosave is off while applications cannot be submitted. | Az automatikus mentés ki van kapcsolva, amíg nem lehet kérelmet beadni. | Die automatische Speicherung ist aus, solange keine Anträge eingereicht werden können. |
| `reviewer_target_courses` | Reviewer screen | changed | Target PTE Courses | Cél PTE-kurzusok | Ziel-PTE-Kurse |
| `student_column_course` | My Status column | changed | PTE course | PTE-kurzus | PTE-Kurs |
| `student_actor_reviewer` | Detail view, history | changed | Reviewer | Bíráló | Gutachter |
| `student_withdraw_confirm_text` | Withdraw question | changed | The reviewer will no longer work on it, and this cannot be undone. You can submit a new request for the same PTE course later. | A bíráló a továbbiakban nem foglalkozik vele, és ez nem vonható vissza. Ugyanarra a PTE-kurzusra később új kérelmet adhat be. | Der Gutachter bearbeitet ihn dann nicht mehr, und das kann nicht rückgängig gemacht werden. Für denselben PTE-Kurs können Sie später einen neuen Antrag stellen. |
| `student_select_pte_courses_placeholder` | Course picker | changed | -- Select & Add PTE Courses -- | -- Válasszon és adjon hozzá PTE-kurzusokat -- | -- PTE-Kurse auswählen und hinzufügen -- |
| `student_resubmission_success` | My Status, after a reply | changed | Your reply was sent to the reviewer. | Válaszát elküldtük a bírálónak. | Ihre Antwort wurde an den Gutachter gesendet. |

32 unused keys were removed in this round (old `auth.*`, `global.*`, `nav.*`, `dashboard.*` groups
and a few student keys no screen used); nothing a user sees changed with that.

## Email texts

New: the verification and password-reset emails (until now English only). Changed: the reviewer
is "Gutachter" in German and the course "PTE-kurzus" in Hungarian (see the terms below).

| Where | EN | HU | DE |
|---|---|---|---|
| verifyAccount email, subject | Action required: verify your PTE account | Teendő: erősítse meg PTE-fiókját | Handlungsbedarf: Bestätigen Sie Ihr PTE-Konto |
| verifyAccount email, heading | Welcome to the PTE Credit Transfer System! | Üdvözöljük a PTE Kreditátviteli rendszerében! | Willkommen im PTE-Kreditübertragungssystem! |
| verifyAccount email, text | Please click the button below to verify your university email address and activate your account. | Kérjük, kattintson az alábbi gombra egyetemi e-mail-címe megerősítéséhez és fiókja aktiválásához. | Bitte klicken Sie auf die Schaltfläche unten, um Ihre Universitäts-E-Mail-Adresse zu bestätigen und Ihr Konto zu aktivieren. |
| verifyAccount email, button | Verify my account | Fiók megerősítése | Konto bestätigen |
| verifyAccount email, footer | If the button doesn't work, copy this link into your browser: | Ha a gomb nem működik, másolja be ezt a linket a böngészőjébe: | Falls die Schaltfläche nicht funktioniert, kopieren Sie diesen Link in Ihren Browser: |
| resetPassword email, subject | PTE Credit Transfer: password reset | PTE Kreditátvitel: jelszó visszaállítása | PTE-Kreditübertragung: Passwort zurücksetzen |
| resetPassword email, heading | Password reset request | Jelszó-visszaállítási kérelem | Anfrage zum Zurücksetzen des Passworts |
| resetPassword email, text | You asked to reset the password of your PTE Credit Transfer account. Click the button below to set a new password. This link is valid for 1 hour. | Jelszó-visszaállítást kért PTE Kreditátviteli fiókjához. Új jelszó beállításához kattintson az alábbi gombra. A link 1 óráig érvényes. | Sie haben das Zurücksetzen des Passworts für Ihr PTE-Kreditübertragungskonto angefordert. Klicken Sie auf die Schaltfläche unten, um ein neues Passwort festzulegen. Dieser Link ist 1 Stunde gültig. |
| resetPassword email, button | Reset password | Jelszó visszaállítása | Passwort zurücksetzen |
| resetPassword email, footer | If you did not ask for this, you can ignore this email. | Ha nem Ön kérte, hagyja figyelmen kívül ezt az e-mailt. | Falls Sie dies nicht angefordert haben, können Sie diese E-Mail ignorieren. |
| Automatic rejection email, reason (semester end) | Not reviewed before the semester closed. | A kérelmet a félév lezárásáig nem bírálták el. | Bis zum Semesterende nicht geprüft. |
| Withdrawn email, text | You withdrew your credit transfer application. The reviewer will no longer work on it. You can submit a new request for the same PTE course at any time. If you did not withdraw it, please contact the Student Office. | Kreditátviteli kérelmét visszavonta. A bíráló már nem foglalkozik vele. Ugyanarra a PTE-kurzusra bármikor beadhat új kérelmet. Ha nem Ön vonta vissza, kérjük, forduljon a Tanulmányi Osztályhoz. | Sie haben Ihren Antrag auf Kreditübertragung zurückgezogen. Der Gutachter bearbeitet ihn nicht mehr. Für denselben PTE-Kurs können Sie jederzeit einen neuen Antrag stellen. Falls Sie ihn nicht zurückgezogen haben, wenden Sie sich bitte an das Studierendensekretariat. |
| Needs-info email, text | The reviewer needs more information before they can decide on your credit transfer application. | A bírálónak további információra van szüksége, mielőtt döntést hozna kreditátviteli kérelméről. | Der Gutachter benötigt weitere Informationen, bevor über Ihren Antrag auf Kreditübertragung entschieden werden kann. |
| Reminder email, text | The reviewer is still waiting for the additional information for your credit transfer application. | A bíráló még mindig várja a kreditátviteli kérelméhez kért további információkat. | Der Gutachter wartet noch auf die zusätzlichen Informationen zu Ihrem Antrag auf Kreditübertragung. |
| Email note heading | Reviewer's message: | A bíráló üzenete: | Nachricht des Gutachters: |

## Terms that must stay consistent

Counted in all screen texts and emails. Where two words were in use, the less common one was
replaced in this round (marked ✎); if you prefer the other word, it is a search-and-replace in
`frontend/src/locales/*.json` and `backend/utils/emailTemplates.js`, then `npm run check:translations`.

| English | Hungarian | German | Notes |
|---|---|---|---|
| application | kérelem | Antrag | never "jelentkezés" / "Bewerbung" for an application |
| application period | jelentkezési időszak | Antragszeitraum | |
| semester | félév | Semester | |
| PTE course (target) | PTE-kurzus | PTE-Kurs | ✎ HU: 3 × "PTE tárgy" and 2 × "PTE kurzus" (no hyphen) changed to "PTE-kurzus" |
| course (completed elsewhere) | kurzus | Kurs | |
| transcript | tanulmányi kivonat | Leistungsübersicht | |
| syllabus | tantárgyleírás | Kursbeschreibung | |
| grading document | értékelési dokumentum | Bewertungsdokument | |
| institution | intézmény | Hochschule | |
| reviewer | bíráló | Gutachter | ✎ DE: 6 × "Prüfer" (texts from Groups 8 and 9, emails) changed to "Gutachter", the role name |
| needs info | kiegészítés szükséges | Informationen benötigt | status label |
| withdraw | visszavon | zurückziehen | |
| draft | vázlat | Entwurf | |
| reply deadline | válaszhatáridő | Antwortfrist | |
| log in | bejelentkezés | anmelden | |
