# Security tests: student side (Groups 1 and 2)

This document describes how the access rules of the PTE digital credit transfer system are tested:
- who may call which API route
- what happens to missing, expired or forged login tokens
- that one student can never read or change another student's data
- that a student only sees and applies for their own study programme's courses (Group 2)

There are two parts:

1. **Automated API check** (`npm run security-check`): 95 checks against the running backend.
2. **Browser checklist**: behaviour that only the frontend can show (redirects, messages, downloads).

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
# 1. Start the backend as usual (it listens on PORT from backend/.env, normally 5050)
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

---

## 3. Pending for the reviewer round

Every application now records its programme (Group 2), so the data supports these checks. The filtering itself is built in the reviewer round.

| Test | Expected | Status |
|---|---|---|
| A reviewer cannot see another programme's applications (list, single application, evidence files) | `403` / filtered list | **Pending (reviewer round).** Today every reviewer can see every application. |

---

## 4. Known limitations

- **CORS is a browser rule.** It stops other websites from reading API answers in a user's browser. It does not stop direct requests (curl, scripts); those are protected by the login token and role checks above.
- **Register reveals registered addresses and Neptun codes.** Signing up with an address that already has an account answers `400 EMAIL_TAKEN` ("Email already registered"), and a Neptun code that is already used answers `400 NEPTUN_TAKEN`, so anyone can check whether an address or Neptun code is registered. Closing this would mean always answering "check your inbox" and emailing the existing account owner instead; not done yet.
- **Someone can use up another person's reset emails.** Sending 3 forgot-password requests for a classmate's address blocks reset emails to that address for up to one hour. This is the unavoidable trade-off of a per-address limit; the block always ends after an hour.
- **Shared IPs.** A whole campus can share one IP (eduroam, computer labs). That is why the per-IP limits are generous (30 per hour); they can be changed in `.env`.
- ~~Forgot password timing~~ **(fixed 2026-10-28).** A real address used to take about 1.9 s longer than an unknown one, because the email was sent before replying. The reply now comes straight after the lookup in both cases (see section 1).
- **Older evidence files without an owner tag.** A few files uploaded before ownership tagging can be opened by reviewers and the superadmin, but not by the student who uploaded them. No other student can open them either.
- **Impersonation shows every programme's courses.** While the superadmin impersonates a student, the course picker uses the admin's token, so it lists the courses of all programmes, not only that student's. Submitting is refused during impersonation anyway. To be fixed in the admin round.
- **Front-end checks are not security.** The route guards and role checks in the browser only decide which screens to show; the backend checks every request itself (sections 1–7).
