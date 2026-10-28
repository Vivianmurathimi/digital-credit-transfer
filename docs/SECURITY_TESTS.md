# Security tests: student side (Group 1)

This document describes how the access rules of the PTE digital credit transfer system are tested:
- who may call which API route
- what happens to missing, expired or forged login tokens
- that one student can never read or change another student's data

There are two parts:

1. **Automated API check** (`npm run security-check`): 62 checks against the running backend.
2. **Browser checklist**: behaviour that only the frontend can show (redirects, messages, downloads).

---

## 1. Automated API check

### How to run it

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

The script prints `PASS`, `FAIL` or `SKIP` per check and a total. It exits with code 0 only if nothing failed.

### Safety rules built into the script

- **Changes no data and sends no emails.** Every request is either read-only or one the server must refuse *before* it saves anything:
  - forgot password uses an address that does not exist
  - the only login attempts use wrong passwords
- **Destructive checks are guarded.** "Student A deletes B's file" and "A submits with B's file" would really delete or save something if the ownership check were broken. They only run after the read-only check "A opens B's file" has passed; otherwise they are skipped.
- **Refuses to run when `NODE_ENV=production`.**
- **Never prints `JWT_SECRET` or any token.** Test tokens are signed locally with the secret from `backend/.env` and only sent to the server.
- **Picks its test users from the database** (read-only):
  - student B: a student with an application and an uploaded file
  - student A: another student with an uploaded file
  - one reviewer and one superadmin

  If such users are missing, it stops and says what is needed.

### What it checks

| # | Group | What is checked | Expected |
|---|---|---|---|
| 1 | **No token** | All 20 protected routes: applications, uploads, users, settings, PTE courses, term archive, refresh-token | `401 NO_TOKEN` |
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
| 5 | **Allowed reads** | A reads own applications; B opens own file | `200` |
| | | Reviewer reads the application list and opens a student's file | `200` |
| | | Superadmin reads the settings and the user list | `200` |
| 6 | **Public routes** (no token) | Login with an unknown email, and with a real email + wrong password (same answer, so accounts cannot be guessed) | `401 INVALID_CREDENTIALS` |
| | | Register with empty fields | `400 MISSING_FIELDS` |
| | | Forgot password with an unknown address | `200` with the same text as for a real address |
| | | Reset password, bad link | `400 INVALID_RESET_LINK` |
| | | Verify email, bad link | `400 INVALID_VERIFY_LINK` |
| | | Email notification link, bad link | `410 INVALID_LINK` |
| | | A stale token sent to a public route is ignored | `401 INVALID_CREDENTIALS` |
| 7 | **CORS** | The frontend address is allowed | `Access-Control-Allow-Origin` set |
| | | Download file names are readable | `Content-Disposition` exposed |
| | | A foreign website gets no CORS headers, and no server error | no CORS headers |

**Forgot password, real address:** the script does not call this with a real address, because that would send an email. Reading the code (`backend/routes/auth.js`, forgot-password route) confirms that both branches return the same status (`200`) and the same text.

### Last result

| Date | Server | Result |
|---|---|---|
| 2026-10-28 | local development backend | **62 passed, 0 failed, 0 skipped**; 0 emails sent |

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

---

## 3. Planned tests (Group 2)

| Test | Expected | Status |
|---|---|---|
| A reviewer cannot see another programme's applications (list, single application, evidence files) | `403` / filtered list | Planned for Group 2, together with per-programme reviewer assignment. Today every reviewer can see every application. |

---

## 4. Known limitations

- **CORS is a browser rule.** It stops other websites from reading API answers in a user's browser. It does not stop direct requests (curl, scripts); those are protected by the login token and role checks above.
- **Forgot password timing.** For a real address the server also creates a reset link and sends the email before answering. The answer text is identical, but it takes noticeably longer, so someone measuring response times could guess whether an address is registered. A fix (answer first, then send the email) is parked.
- **Older evidence files without an owner tag.** A few files uploaded before ownership tagging can be opened by reviewers and the superadmin, but not by the student who uploaded them. No other student can open them either.
- **Front-end checks are not security.** The route guards and role checks in the browser only decide which screens to show; the backend checks every request itself (sections 1–7).
