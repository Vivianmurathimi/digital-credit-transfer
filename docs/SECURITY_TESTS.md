# Security tests: student side (Group 1)

This document describes how the access rules of the PTE digital credit transfer system are tested:
- who may call which API route
- what happens to missing, expired or forged login tokens
- that one student can never read or change another student's data

There are two parts:

1. **Automated API check** (`npm run security-check`): 67 checks against the running backend.
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

- **Changes no data and sends no emails.** Every request is either read-only or one the server must refuse *before* it saves anything. The one exception is the rate-limit checks (section 8), which add rows to `rate_limit_hits`. The script deletes exactly those rows at the end, even after a crash: this computer's IP and its own test addresses, from the start of the run. Otherwise this computer would stay rate-limited for an hour. Other requests:
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
| | | Forgot password with an email that is not text | `400 MISSING_FIELDS` |
| | | Reset password, bad link | `400 INVALID_RESET_LINK` |
| | | Verify email, bad link | `400 INVALID_VERIFY_LINK` |
| | | Email notification link, bad link | `410 INVALID_LINK` |
| | | A stale token sent to a public route is ignored | `401 INVALID_CREDENTIALS` |
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

---

## 3. Planned tests (Group 2)

| Test | Expected | Status |
|---|---|---|
| A reviewer cannot see another programme's applications (list, single application, evidence files) | `403` / filtered list | Planned for Group 2, together with per-programme reviewer assignment. Today every reviewer can see every application. |

---

## 4. Known limitations

- **CORS is a browser rule.** It stops other websites from reading API answers in a user's browser. It does not stop direct requests (curl, scripts); those are protected by the login token and role checks above.
- **Register reveals registered addresses and Neptun codes.** Signing up with an address that already has an account answers `400 EMAIL_TAKEN` ("Email already registered"), and a Neptun code that is already used answers `400 NEPTUN_TAKEN`, so anyone can check whether an address or Neptun code is registered. Closing this would mean always answering "check your inbox" and emailing the existing account owner instead; not done yet.
- **Someone can use up another person's reset emails.** Sending 3 forgot-password requests for a classmate's address blocks reset emails to that address for up to one hour. This is the unavoidable trade-off of a per-address limit; the block always ends after an hour.
- **Shared IPs.** A whole campus can share one IP (eduroam, computer labs). That is why the per-IP limits are generous (30 per hour); they can be changed in `.env`.
- ~~Forgot password timing~~ **(fixed 2026-10-28).** A real address used to take about 1.9 s longer than an unknown one, because the email was sent before replying. The reply now comes straight after the lookup in both cases (see section 1).
- **Older evidence files without an owner tag.** A few files uploaded before ownership tagging can be opened by reviewers and the superadmin, but not by the student who uploaded them. No other student can open them either.
- **Front-end checks are not security.** The route guards and role checks in the browser only decide which screens to show; the backend checks every request itself (sections 1–7).
