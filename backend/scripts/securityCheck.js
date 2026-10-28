/**
 * Security check for the API (Group 1, Step 10). See docs/SECURITY_TESTS.md.
 *
 * Run against a RUNNING backend:   npm run security-check
 * Other address:                   SECURITY_CHECK_URL=http://localhost:5099 npm run security-check
 *
 * Every request is either read-only or one the server must refuse before it saves anything,
 * so the check changes no data and sends no emails. The only exception: the rate-limit
 * checks add rows to rate_limit_hits, and the script deletes exactly those rows at the end
 * (otherwise this computer would stay rate-limited for an hour). Test tokens are signed locally with
 * JWT_SECRET from backend/.env; neither the secret nor the tokens are ever printed.
 */
process.env.DOTENV_CONFIG_QUIET = 'true'; // keep dotenv's startup lines out of the report
require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. This check is for development and test servers only.');
    process.exit(1);
}

const jwt = require('jsonwebtoken');
const { JWT_SECRET, ALGORITHM, signSessionToken } = require('../config/jwt');
const { CORS_ORIGINS } = require('../config/urls');
const pool = require('../db');
const minioClient = require('../minio');
const { getFileOwner } = require('../utils/fileOwner');
const { LIMITS, hashKey, normalizeEmail } = require('../utils/rateLimit');

const BASE = (process.env.SECURITY_CHECK_URL || `http://localhost:${process.env.PORT || 5050}`).replace(/\/+$/, '');
const API = `${BASE}/api`;
const FRONTEND_ORIGIN = CORS_ORIGINS[0];
const FORGOT_MESSAGE = 'If that email exists, a reset link has been sent.';
const UNKNOWN_EMAIL = 'nobody@security-check.invalid';

// ---------- rate-limit rows created by this run (deleted at the end) ----------

// The backend sees this script as one of these addresses
const LOCAL_IP_HASHES = ['127.0.0.1', '::1'].map(hashKey);
const testEmailHashes = new Set([hashKey(normalizeEmail(UNKNOWN_EMAIL))]);
let runStartedAt = null; // database time when the run began

const testEmail = (label) => {
    const email = `rl-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@security-check.invalid`;
    testEmailHashes.add(hashKey(normalizeEmail(email)));
    return email;
};

const countHits = async (bucket, hashes) => (await pool.query(
    "SELECT count(*)::int AS hits FROM rate_limit_hits WHERE bucket = $1 AND key_hash = ANY($2) AND hit_at > now() - interval '1 hour'",
    [bucket, hashes]
)).rows[0].hits;

// Clears this computer's IP rows from this run only, so the next test starts with a full quota
const resetOwnIpRows = () => pool.query(
    'DELETE FROM rate_limit_hits WHERE hit_at >= $1 AND key_hash = ANY($2)',
    [runStartedAt, LOCAL_IP_HASHES]
);

// Deletes only rows from this run: this computer's IP and the test addresses, since the start
const cleanupRateLimitRows = async () => {
    if (!runStartedAt) return 0;
    const { rowCount } = await pool.query(
        'DELETE FROM rate_limit_hits WHERE hit_at >= $1 AND key_hash = ANY($2)',
        [runStartedAt, [...LOCAL_IP_HASHES, ...testEmailHashes]]
    );
    return rowCount;
};

// ---------- small helpers ----------

const results = { pass: 0, fail: 0, skip: 0 };

const report = (ok, name, detail = '') => {
    results[ok ? 'pass' : 'fail'] += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    return ok;
};

const skip = (name, why) => {
    results.skip += 1;
    console.log(`SKIP  ${name}  (${why})`);
};

const section = (title) => console.log(`\n== ${title}`);

// Sends one request; returns { status, code, body, headers }
const call = async (method, path, { token, json, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (json !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
    }
    const res = await fetch(`${API}/${path}`, init);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON (e.g. a file) */ }
    return { status: res.status, code: body && body.code, body, headers: res.headers };
};

// Checks status (and code, if given)
const expect = async (name, request, status, code) => {
    const res = await request;
    const ok = res.status === status && (code === undefined || res.code === code);
    report(ok, name, ok ? `${status}${code ? ` ${code}` : ''}` : `got ${res.status} ${res.code || ''}, expected ${status} ${code || ''}`);
    return ok;
};

// Test tokens (never printed)
const tokenFor = (user) => signSessionToken({ id: user.id, role: user.role });
const now = () => Math.floor(Date.now() / 1000);
const expiredToken = (user) => jwt.sign({ id: user.id, role: user.role, sessionStart: now() - 3600, exp: now() - 60 }, JWT_SECRET, { algorithm: ALGORITHM });
const tooOldToken = (user) => signSessionToken({ id: user.id, role: user.role }, now() - 9 * 3600);
const wrongSecretToken = (user) => jwt.sign({ id: user.id, role: user.role, sessionStart: now() }, 'not-the-real-secret', { algorithm: ALGORITHM, expiresIn: '30m' });
const unsignedToken = (user) => {
    const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${part({ alg: 'none', typ: 'JWT' })}.${part({ id: user.id, role: 'superadmin', sessionStart: now(), exp: now() + 1800 })}.`;
};

// ---------- test data (read-only) ----------

// Who uploaded each evidence file, from the file tags in MinIO
const listFileOwners = async () => {
    const names = await new Promise((resolve, reject) => {
        const found = [];
        const stream = minioClient.listObjects('transcripts', '', true);
        stream.on('data', (obj) => found.push(obj.name));
        stream.on('end', () => resolve(found));
        stream.on('error', reject);
    });
    const byOwner = new Map();
    for (const name of names) {
        const { ownerId } = await getFileOwner(name);
        if (ownerId) byOwner.set(ownerId, [...(byOwner.get(ownerId) || []), name]);
    }
    return byOwner;
};

const loadTestData = async () => {
    const users = (await pool.query('SELECT id, role, email FROM users ORDER BY id')).rows;
    const apps = (await pool.query('SELECT id, student_id FROM applications ORDER BY id')).rows;
    const filesByOwner = await listFileOwners();

    const reviewer = users.find((u) => u.role === 'reviewer');
    const admin = users.find((u) => u.role === 'superadmin');
    // Student B: has an application and a tagged file. Student A: another student with a tagged file.
    const students = users.filter((u) => u.role === 'student' && filesByOwner.has(u.id));
    const studentB = students.find((u) => apps.some((a) => a.student_id === u.id));
    const studentA = students.find((u) => studentB && u.id !== studentB.id);

    const missing = [];
    if (!reviewer) missing.push('a reviewer account');
    if (!admin) missing.push('a superadmin account');
    if (!studentB) missing.push('a student with an application and an uploaded file (student B)');
    if (!studentA) missing.push('a second student with an uploaded file (student A)');
    if (missing.length) {
        console.error(`Cannot run: the database needs ${missing.join(', ')}.`);
        process.exit(1);
    }

    return {
        reviewer,
        admin,
        studentA,
        studentB,
        appOfB: apps.find((a) => a.student_id === studentB.id),
        fileOfB: filesByOwner.get(studentB.id)[0],
        goneUser: { id: Math.max(...users.map((u) => u.id)) + 100000, role: 'student' },
    };
};

// ---------- the checks ----------

const run = async () => {
    try {
        await fetch(`${API}/settings/status`);
    } catch {
        console.error(`Cannot reach the backend at ${BASE}. Start it first (or set SECURITY_CHECK_URL).`);
        process.exit(1);
    }

    runStartedAt = (await pool.query('SELECT now() AS t')).rows[0].t;
    const d = await loadTestData();
    const A = tokenFor(d.studentA);
    const B = tokenFor(d.studentB);
    const R = tokenFor(d.reviewer);
    const S = tokenFor(d.admin);
    const fileB = encodeURIComponent(d.fileOfB);

    console.log(`Security check against ${BASE}`);
    console.log(`Test users: student A #${d.studentA.id}, student B #${d.studentB.id}, reviewer #${d.reviewer.id}, superadmin #${d.admin.id}`);

    section('1. No token -> 401 NO_TOKEN');
    const protectedRoutes = [
        ['GET', 'applications/mine'], ['GET', 'applications'], ['GET', `applications/student/${d.studentB.id}`],
        ['POST', 'applications'], ['PUT', `applications/${d.appOfB.id}/status`], ['PUT', `applications/${d.appOfB.id}/resubmit`],
        ['POST', 'uploads'], ['GET', `uploads/${fileB}`], ['DELETE', `uploads/${fileB}`],
        ['GET', 'users'], ['GET', 'users/all'], ['PUT', `users/${d.studentB.id}/language`], ['PUT', `users/${d.studentB.id}/role`],
        ['GET', 'pte-courses'], ['GET', 'settings/status'], ['PUT', 'settings/toggle'],
        ['GET', 'archive'], ['POST', 'archive/generate'], ['GET', 'archive/x.pdf/download'],
        ['POST', 'refresh-token'],
    ];
    for (const [method, path] of protectedRoutes) {
        await expect(`${method} /api/${path}`, call(method, path), 401, 'NO_TOKEN');
    }

    section('2. Bad tokens -> 401');
    await expect('Expired token', call('GET', 'applications/mine', { token: expiredToken(d.studentA) }), 401, 'TOKEN_EXPIRED');
    await expect('Token signed with the wrong secret', call('GET', 'applications/mine', { token: wrongSecretToken(d.studentA) }), 401, 'INVALID_TOKEN');
    await expect('Unsigned token (alg "none") claiming superadmin', call('GET', 'users', { token: unsignedToken(d.studentA) }), 401, 'INVALID_TOKEN');
    await expect('Session older than 8 hours', call('GET', 'applications/mine', { token: tooOldToken(d.studentA) }), 401, 'SESSION_TOO_OLD');
    await expect('Token of a deleted account', call('GET', 'pte-courses', { token: tokenFor(d.goneUser) }), 401, 'ACCOUNT_GONE');
    await expect('Malformed Authorization header', call('GET', 'pte-courses', { headers: { Authorization: 'Bearer' } }), 401, 'NO_TOKEN');

    section('3. Wrong role -> 403 FORBIDDEN_ROLE');
    await expect('Student: all applications', call('GET', 'applications', { token: A }), 403, 'FORBIDDEN_ROLE');
    await expect('Student: change an application status', call('PUT', `applications/${d.appOfB.id}/status`, { token: A, json: { status: 'approved' } }), 403, 'FORBIDDEN_ROLE');
    await expect('Student: user list', call('GET', 'users', { token: A }), 403, 'FORBIDDEN_ROLE');
    await expect('Student: change a role', call('PUT', `users/${d.studentA.id}/role`, { token: A, json: { newRole: 'superadmin' } }), 403, 'FORBIDDEN_ROLE');
    await expect('Student: open/close submissions', call('PUT', 'settings/toggle', { token: A, json: { isOpen: false } }), 403, 'FORBIDDEN_ROLE');
    await expect('Student: term archive', call('GET', 'archive', { token: A }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: user list', call('GET', 'users/all', { token: R }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: change a role', call('PUT', `users/${d.reviewer.id}/role`, { token: R, json: { newRole: 'superadmin' } }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: open/close submissions', call('PUT', 'settings/toggle', { token: R, json: { isOpen: false } }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: generate a term book', call('POST', 'archive/generate', { token: R, json: { from: '2025-01-01', to: '2025-06-30' } }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: upload as a student', call('POST', 'uploads', { token: R }), 403, 'FORBIDDEN_ROLE');
    await expect('Superadmin: student-only "my applications"', call('GET', 'applications/mine', { token: S }), 403, 'FORBIDDEN_ROLE');
    await expect('Superadmin: submit an application', call('POST', 'applications', { token: S, json: {} }), 403, 'FORBIDDEN_ROLE');

    section('4. Student A vs student B -> refused');
    await expect("A reads B's applications", call('GET', `applications/student/${d.studentB.id}`, { token: A }), 403, 'FORBIDDEN_ROLE');
    await expect("A changes B's language", call('PUT', `users/${d.studentB.id}/language`, { token: A, json: { language: 'en' } }), 403, 'NOT_OWNER');
    await expect("A resubmits B's application", call('PUT', `applications/${d.appOfB.id}/resubmit`, { token: A, json: { student_resubmit_note: 'x', new_files: '' } }), 403, 'NOT_OWNER');
    const readRefused = await expect("A opens B's file", call('GET', `uploads/${fileB}`, { token: A }), 403, 'NOT_OWNER');

    // These two would really change data if the ownership check were broken,
    // so they only run once the read-only ownership check above has passed
    if (!readRefused) {
        skip("A deletes B's file", 'ownership check failed above; not risking B\'s file');
        skip("A submits an application with B's file", 'ownership check failed above; not risking a real submission');
    } else {
        await expect("A deletes B's file", call('DELETE', `uploads/${fileB}`, { token: A }), 403, 'NOT_OWNER');
        const settings = await call('GET', 'settings/status', { token: A });
        if (!settings.body || settings.body.isOpen !== true) {
            skip("A submits an application with B's file", 'submissions are closed, so the server stops earlier');
        } else {
            await expect("A submits an application with B's file",
                call('POST', 'applications', { token: A, json: { fulfilled_courses_json: [{ course_name: 'Security check', file: d.fileOfB }], pte_course_names: 'Security check' } }),
                403, 'FILES_NOT_OWNED');
        }
    }

    section('5. Allowed reads still work -> 200');
    await expect('Student A reads own applications', call('GET', 'applications/mine', { token: A }), 200);
    await expect('Student B opens own file', call('GET', `uploads/${fileB}`, { token: B }), 200);
    await expect('Reviewer reads the application list', call('GET', 'applications', { token: R }), 200);
    await expect("Reviewer opens a student's file", call('GET', `uploads/${fileB}`, { token: R }), 200);
    await expect('Superadmin reads the settings', call('GET', 'settings/status', { token: S }), 200);
    await expect('Superadmin reads the user list', call('GET', 'users', { token: S }), 200);

    section('6. Public routes work without a token');
    await expect('Login, unknown email', call('POST', 'login', { json: { email: UNKNOWN_EMAIL, password: 'wrong' } }), 401, 'INVALID_CREDENTIALS');
    await expect('Login, real email + wrong password (same answer)', call('POST', 'login', { json: { email: d.studentA.email, password: 'definitely-wrong-password' } }), 401, 'INVALID_CREDENTIALS');
    await expect('Register with empty fields', call('POST', 'register', { json: {} }), 400, 'MISSING_FIELDS');
    const forgot = await call('POST', 'forgot-password', { json: { email: UNKNOWN_EMAIL } });
    report(forgot.status === 200 && forgot.body && forgot.body.success === true && forgot.body.message === FORGOT_MESSAGE,
        'Forgot password, unknown address (no email sent)', `${forgot.status}, same text as for a real address`);
    await expect('Forgot password, email that is not text', call('POST', 'forgot-password', { json: { email: 123 } }), 400, 'MISSING_FIELDS');
    await expect('Reset password, bad link', call('POST', 'reset-password/not-a-real-link', { json: { newPassword: 'Abcdef12!' } }), 400, 'INVALID_RESET_LINK');
    await expect('Verify email, bad link', call('GET', 'verify/not-a-real-link'), 400, 'INVALID_VERIFY_LINK');
    await expect('Email link, bad link', call('GET', 'email-link/not-a-real-link'), 410, 'INVALID_LINK');
    await expect('Public route ignores a stale token', call('POST', 'login', { token: expiredToken(d.studentA), json: { email: UNKNOWN_EMAIL, password: 'x' } }), 401, 'INVALID_CREDENTIALS');

    section('7. CORS');
    const allowed = await call('GET', 'settings/status', { headers: { Origin: FRONTEND_ORIGIN } });
    report(allowed.headers.get('access-control-allow-origin') === FRONTEND_ORIGIN, `Frontend origin ${FRONTEND_ORIGIN} is allowed`);
    report((allowed.headers.get('access-control-expose-headers') || '').includes('Content-Disposition'), 'Download file names (Content-Disposition) are readable');
    const foreign = await call('GET', 'settings/status', { headers: { Origin: 'https://evil.example' } });
    report(!foreign.headers.get('access-control-allow-origin') && foreign.status !== 500, 'Foreign origin gets no CORS headers (and no 500)');

    section('8. Rate limits (no emails: only addresses that do not exist)');
    const sameForgotReply = (r) => r.status === 200 && r.body && r.body.success === true && r.body.message === FORGOT_MESSAGE;
    const forgotFor = (email) => call('POST', 'forgot-password', { json: { email } });

    // The per-address tests need more requests than the per-address limit, from this one computer.
    // Each test starts by clearing this run's IP rows, so earlier tests don't use up its quota.
    const addressTries = LIMITS.forgotPerEmail + 2;
    await resetOwnIpRows();
    const ipUsed = await countHits('forgot_ip', LOCAL_IP_HASHES); // left from before this run
    if (ipUsed + addressTries > LIMITS.forgotPerIp) {
        skip('Forgot password per-address limit', `needs ${addressTries} requests from this computer, but only ${LIMITS.forgotPerIp - ipUsed} of the per-IP limit are left this hour`);
        skip('Simultaneous requests cannot exceed the limit', 'same reason');
    } else {
        // Per address: requests spelled differently (case, spaces) -> one count, stopped at the limit
        const base = testEmail('address');
        const variants = [base, base.toUpperCase(), `  ${base}`, `${base}  `, base.replace(/^rl/, 'RL')];
        const spellings = Array.from({ length: addressTries }, (_, i) => variants[i % variants.length]);
        const replies = [];
        for (const spelling of spellings) replies.push(await forgotFor(spelling));
        const counted = await countHits('forgot_email', [hashKey(normalizeEmail(base))]);
        report(replies.every(sameForgotReply) && counted === LIMITS.forgotPerEmail,
            `Forgot password per address: ${spellings.length} requests, same reply each time, ${LIMITS.forgotPerEmail} counted`,
            `counted ${counted}; spelling (case/spaces) does not matter`);

        // The same number of requests at the same moment for one address -> still only the limit
        await resetOwnIpRows();
        const parallel = testEmail('parallel');
        const parallelReplies = await Promise.all(Array.from({ length: addressTries }, () => forgotFor(parallel)));
        const parallelCounted = await countHits('forgot_email', [hashKey(normalizeEmail(parallel))]);
        report(parallelReplies.every(sameForgotReply) && parallelCounted === LIMITS.forgotPerEmail,
            'Simultaneous requests cannot exceed the limit', `${addressTries} at once, ${parallelCounted} counted`);
    }

    // Per IP: fill up this computer's forgot-password quota (different unknown addresses), then one more
    await resetOwnIpRows();
    const ipBefore = await countHits('forgot_ip', LOCAL_IP_HASHES);
    const ipRequests = Math.max(LIMITS.forgotPerIp - ipBefore, 0) + 1;
    const ipReplies = [];
    for (let i = 0; i < ipRequests; i += 1) ipReplies.push(await forgotFor(testEmail('ip')));
    const ipAfter = await countHits('forgot_ip', LOCAL_IP_HASHES);
    report(ipReplies.every(sameForgotReply) && ipAfter === LIMITS.forgotPerIp,
        `Forgot password per IP: same reply over the limit, stopped at ${LIMITS.forgotPerIp}`, `${ipRequests} requests, ${ipAfter} counted`);

    // Register per IP: empty attempts (nothing is created) until the limit, then 429
    const regBefore = await countHits('register_ip', LOCAL_IP_HASHES);
    const regReplies = [];
    for (let i = 0; i < Math.max(LIMITS.registerPerIp - regBefore, 0); i += 1) regReplies.push(await call('POST', 'register', { json: {} }));
    const overLimit = await call('POST', 'register', { json: {} });
    report(regReplies.every((r) => r.status === 400) && overLimit.status === 429 && overLimit.code === 'TOO_MANY_REQUESTS',
        `Register per IP: 429 TOO_MANY_REQUESTS after ${LIMITS.registerPerIp} attempts`, `${overLimit.status} ${overLimit.code || ''}`);

    console.log(`\n${results.pass} passed, ${results.fail} failed, ${results.skip} skipped`);
    return results.fail === 0;
};

// Removes this run's rate-limit rows, also after a crash
const finish = async (ok) => {
    try {
        const removed = await cleanupRateLimitRows();
        if (removed) console.log(`(removed ${removed} rate-limit rows created by this run)`);
    } catch (err) {
        console.error('Could not remove this run\'s rate-limit rows:', err.message);
    }
    // Exits explicitly: db.js keeps its startup test connection open, so the pool never closes by itself
    process.exit(ok ? 0 : 1);
};

run()
    .then(finish)
    .catch((err) => {
        console.error('Security check crashed:', err.message);
        return finish(false);
    });
