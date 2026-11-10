# Reviewer side: final manual browser checklist

Uses the demo data, so nothing in the development database changes. Tick each box.
Each programme has its own reviewer (both programmes' logins are in the Setup table below).
How it all works: `backend/REVIEWER.md`.

## Setup

```
cd backend
npm run demo:seed      # prints the logins, the applications, and the jobs:run commands with the demo's dates
npm run demo:start     # the backend on the demo database and buckets (stop the normal backend first: same port)
```
In a second terminal: `cd frontend && npm start`, then open http://localhost:3000.

All demo passwords: `Demo1234!`

| Role | Login | Notes |
|---|---|---|
| Superadmin | demo.admin@staff.example | |
| Reviewer, Computer Science | demo.reviewer.cs@staff.example | Dr. Katalin Szabó |
| Reviewer, Civil Engineering | demo.reviewer.civil@staff.example | Dr. Péter Horváth (Hungarian emails) |
| Students CS | demo.anna@, demo.bence@, demo.csilla@, demo.daniel@ (all @students.example) | |
| Students Civil | demo.eszter@, demo.ferenc@, demo.gabor@ (all @students.example) | |

Emails go to the Mailtrap inbox from `backend/.env`. Start again from a clean state at any time with `npm run demo:seed`; stop `demo:start` first, then start it again.

## 1. Two programmes, two reviewers: each sees only their own

- [ ] **CS reviewer, Pending:** Anna (CS202) and Bence (CS305, resubmitted).
- [ ] **CS reviewer, Needs Info:** Csilla.
- [ ] **CS reviewer, Completed:** Dániel (approved, grade 4) and Anna (SEC300, rejected by System).
- [ ] **CS reviewer, never listed:** no Civil student; Gábor's withdrawn application.
- [ ] **Civil reviewer, Pending:** Gábor.
- [ ] **Civil reviewer, Completed:** Eszter (rejected by the reviewer) and Ferenc (rejected by Admin).
- [ ] **Civil reviewer, never listed:** no CS student; Eszter's previous-semester application (Completed shows only the current semester).
- [ ] **Bence's details (CS reviewer):**
  - courses, institution (Politecnico di Milano), the ECTS comparison (4 of 5: not enough), and the conversation (note → request → reply)
  - every file opens: transcript, syllabus, grading scale, and the reply's course description
- [ ] **Files from another programme:** copy the address of one of Bence's files and log in as the **Civil** reviewer. Opening that address gives "not found".
- [ ] **Search** finds a student by name without accents (e.g. "kovacs") and by Neptun code (DMCS01).

## 2. Invite, accept, replace, remove

As the admin, use **Staff access** on the admin dashboard (admin round Group 2):

- [ ] **Invite without replace is refused:** email `new.reviewer@staff.example`, role Reviewer, programme Computer Science Engineering, language English, "Replace the current reviewer" not ticked. Expected: "This programme already has a reviewer".
- [ ] **Invite with replace:** the same, with "Replace the current reviewer" ticked. The screen shows the link, the invite is listed as **Sent**, and the invite email arrives in Mailtrap.
- [ ] **Before accepting,** Dr. Szabó can still log in and work.
- [ ] **The accept page:** open the link. The page shows the programme. Check it in EN, HU and DE, and that a 7-character password is refused.
- [ ] **Accept:** enter a name and a password.
  - Logging in as new.reviewer@staff.example shows the CS applications, including Csilla's needs-info application.
  - Dr. Szabó is logged out on her next click and can't log in again.
- [ ] **The link works only once:** opening it again shows that it is no longer valid.
- [ ] **Remove the new reviewer.** Find their id:
  ```
  curl -s localhost:5050/api/users -H "Authorization: Bearer $TOKEN" | node -pe "JSON.parse(require('fs').readFileSync(0)).users.filter(u=>u.role==='reviewer').map(u=>u.id+' '+u.email).join('\n')"
  ```
  Then remove them:
  ```
  curl -s -X PUT localhost:5050/api/users/<id>/remove-reviewer -H "Authorization: Bearer $TOKEN"
  ```
  They are refused on their next click and can't log in. The admin banner shows a red "No active reviewer" warning for Computer Science.
- [ ] **Re-invite Dr. Szabó:** use her address `demo.reviewer.cs@staff.example`, programme CS. On the accept page her name is shown read-only. After accepting with a new password, she sees her applications again.

## 3. The admin acting as a reviewer

- [ ] **The banner:** as the admin, it shows one line per programme: pending, waiting for the student, the semester's last day, and the reviewer's name.
- [ ] **Act as a reviewer → Dr. Szabó:**
  - the same list and details she sees, nothing from Civil, and files open
  - the banner "Acting as Dr. Szabó (Reviewer)" at the top
  - "Exit" returns to the admin dashboard
- [ ] **A decision while acting as her** (e.g. approve Anna's CS202) is shown as decided by **Admin**:
  - in the details
  - in the student's My Status
  - in the history (no admin name anywhere)
- [ ] **Admin override buttons** (reset, force approve) are disabled, with the tooltip "Moved to admin overrides – coming soon".

## 4. Each decision type (as a reviewer)

- [ ] **Approve:**
  - The panel requires a grade 2–5 (shown with the Hungarian name, e.g. "4 (jó – good)"), and the note is optional.
  - The confirmation step shows a summary.
  - After saving, the application moves to Completed.
  - The student gets an email with the grade and sees the grade in My Status.
- [ ] **Reject:**
  - Without a reason, the panel refuses.
  - With a reason, it moves to Completed.
  - The student's email and My Status show the reason.
- [ ] **Request information:**
  - Without a message, the panel refuses.
  - The panel shows the reply date (the third day, 23:59).
  - The application moves to Needs Info, and the student's email has the message and the deadline.
- [ ] **The student replies** (log in as that student, add a file and a note): the application is back in Pending with the reply in the conversation, and the reviewer gets a "student replied" email.
- [ ] **Two tabs, one decision:** open the same pending application in two browser tabs and decide in both. The second one says it has already been decided.
- [ ] **Text limit:** a 2001-character note is refused, and the counter shows the limit.

## 5. Needs-info deadline: automatic rejection

- [ ] Run the "Csilla's deadline has passed" command that `demo:seed` printed:
  ```
  DB_NAME=credit_demo npm run jobs:run -- --now=<day after her deadline>T08:00:00Z --yes
  ```
  It reports `overdue information requests: 1`.
- [ ] **Csilla:** rejected by **System**, with the reason in her language (German: "Keine Antwort auf die Informationsanfrage."). She gets the email.
- [ ] **CS reviewer:** the application is under Completed, with "Decided by System" and the reason in the reviewer's language.
- [ ] **Run the same command again:** it reports 0, and no second email is sent.

## 6. Reminder emails before the semester ends

- [ ] Run the "7 days before the semester end" command. Each reviewer gets an email (CS in English, Civil in Hungarian) with the semester's last day and two numbers: waiting for your decision, and waiting for the student's reply.
- [ ] Run it again: `reviewer reminders: 0`, and no second email.
- [ ] Run the "semester's last day" command: one more email each, saying today is the last day.

## 7. Semester close: automatic rejection

- [ ] Run the "semester has ended" command: everything still pending or waiting for information is rejected by System ("Not reviewed before the semester closed"), and each student gets the email.
- [ ] Run it again: 0.
- [ ] The reviewer's Completed tab shows them as "Decided by System". The browser still lives in the real date, inside the semester, so they are listed as this semester's decisions.

## 8. Term book PDF

- [ ] As the admin, generate the term book for the current semester's dates (`demo:seed` prints them) and download it.
- [ ] **Approved application:** the final grade "4 (jó – good)" and the reviewer's name.
- [ ] **Rejected by Admin:** "Decided by Admin", without a name.
- [ ] **Rejected by System:** "Decided by System" and the English reason.
- [ ] **After step 7:** the closed applications show as not reviewed before the semester closed.
- [ ] **Accents:** printed correctly (Dániel Kiss, Ferenc Molnár).

## 9. All three languages (the app has a light theme only)

Go through the reviewer list, a details page, the decision panel (both steps), the admin banner, the accept page and the student's My Status:

- [ ] in **English**, **Magyar** and **Deutsch**: no English left in HU/DE, dates in the language's format, and grade names in the language next to the Hungarian name
- [ ] on a phone-sized window (browser developer tools): the list and the decision panel fit without sideways scrolling

## 10. Colour cues (reviewer group L2)

Colour is never the only signal: each cue below also has its text or an icon.

- [ ] **Status chips:**
  - "⏳ Pending" is blue, "❓ Needs Info" amber, "✓ Approved" green, "✗ Rejected" red.
  - Anna's SEC300 shows "⚙ Rejected · System" in muted red-grey.
  - Bence has a violet "🔄 Resubmitted" chip next to "Pending".
- [ ] **Waiting time:**
  - Anna's CS202 ("Waiting 2 days") is plain text.
  - Dániel's CS401 is an amber "⏱ Waiting 9 days" chip.
  - Ferenc's CE320 (Civil reviewer) is a red "⚠ Waiting 16 days" chip.
- [ ] **Respond by:** Csilla's row (deadline tomorrow) shows a red "⚠ Student must respond by …" chip. Her details show the same in a red-tinted box. With 2 or more days left it is amber with ⏰.
- [ ] **Credits:**
  - Anna's CS202 (6 of 6 ECTS): green "✓ Credits: enough".
  - Bence (4 of 5): red "✗ Credits: not enough".
  - A different credit system: a grey "⚖ … compare manually" chip.
- [ ] **Conversation:** student notes blue, reviewer messages teal, replies violet, automatic reasons grey-red, each with a coloured left border. The kind, author and date stay as text.
- [ ] **Tabs:** each has a blue count badge. The active tab is tinted, underlined, bold and starts with ✓.
- [ ] **Rows:** hovering tints a row. The open row stays light blue with a blue left border.
- [ ] **Decision buttons:** "✓ Approve" green, "❓ Request Info" amber, "✗ Reject" red. In the panel, the final confirm button has the same colour.
- [ ] **No colour without meaning:** read the page as if in greyscale (e.g. the browser's or the system's greyscale filter). Every state is still clear from its text or icon.

## 11. Past semesters, read-only (reviewer group L3)

The demo's previous semester has Bence's approved CS101 (CS) and Eszter's CE101, rejected by System (Civil).

- [ ] **The selector:** as the CS reviewer, there is a "Semester:" selector above the tabs.
  - It shows "Current semester (Demo – current semester)" and "Demo – previous semester (ended …) – read only".
  - The Civil reviewer sees the same selector with their own past application.
- [ ] **Choosing the previous semester:**
  - A grey 🔒 "Past semester – read only" banner appears, the header names that semester, and the Completed tab opens.
  - Only Bence's CS101 is listed, with "✓ Approved". No Civil application is listed.
- [ ] **Its details:** courses, institution, files (they open), notes, history, and the decision: grade 5, decided by Dr. Szabó, and the date.
  - There are no decision buttons; instead a 🔒 note says nothing can be changed.
  - Search still works (e.g. "bence").
- [ ] **Back to "Current semester":** the normal list with decision buttons is back.
- [ ] **Civil reviewer:** Eszter's CE101 shows "⚙ Rejected · System" with the reason in the reviewer's language.
- [ ] **The admin acting as** Dr. Szabó sees the same selector and the same read-only view.
- [ ] **Changes are refused even without the UI** (from `backend`, with `npm run demo:start` running):
  ```
  TOKEN=$(curl -s localhost:5050/api/login -H 'Content-Type: application/json' -d '{"email":"demo.reviewer.cs@staff.example","password":"Demo1234!"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")
  curl -s -X PUT localhost:5050/api/applications/12/status -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"status":"rejected","note":"x"}'
  ```
  The answer is `SEMESTER_ENDED` (409). Use the id `demo:seed` printed for "approved, grade 5, previous semester".
- [ ] **Files can't be deleted:** a file of a submitted application can't be deleted by its student. The security check covers this (409 `FILE_IN_USE`); in the browser, removing a row in a new draft still works.
- [ ] **The draft warning:** in the student form during the application period's last 7 days, the warning ends with "Unsent drafts are deleted when the semester ends." To see it in the demo, the current semester's application period would have to end within 7 days.

## When done

Stop `demo:start` and start the normal backend again (`node server.js`). The demo database and buckets stay until the next `demo:seed`.
