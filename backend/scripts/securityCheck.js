/**
 * Security check for the API (Group 1, Step 10). See docs/SECURITY_TESTS.md.
 *
 * Run against a RUNNING backend:   npm run security-check
 * Other address:                   SECURITY_CHECK_URL=http://localhost:5099 npm run security-check
 *
 * Every request is either read-only or one the server must refuse before it saves anything
 * (also every withdraw request: only refused ones are sent). Section 4d adds two temporary
 * applications of student A (rejected, withdrawn) and deletes them again; section 4e moves the
 * current semester's days, adds a temporary past semester with two applications of A, and puts
 * everything back. Section 4f (reviewer access) adds temporary applications, invites and reviewer
 * accounts, deactivates the test reviewer for a moment, and puts everything back; its few invite
 * emails go only to @security-check.invalid addresses (caught by Mailtrap). Section 4h (decisions)
 * uses a temporary student with such an address, so its decision emails reach nobody real. Otherwise
 * the check changes no data and sends no emails. The only exception: the rate-limit
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
const { EVIDENCE_BUCKET, ARCHIVE_BUCKET } = require('../config/buckets');
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

// ---------- drafts of students A and B (put back at the end) ----------

// The drafts tests overwrite A's and B's draft; their real drafts are kept here and restored
let draftBackup = null; // { ids, rows }
const restoreDrafts = async () => {
    if (!draftBackup) return 0;
    const { ids, rows } = draftBackup;
    await pool.query('DELETE FROM application_drafts WHERE student_id = ANY($1)', [ids]);
    for (const r of rows) {
        await pool.query('INSERT INTO application_drafts (student_id, version, data, updated_at) VALUES ($1, $2, $3, $4)',
            [r.student_id, r.version, JSON.stringify(r.data), r.updated_at]);
    }
    draftBackup = null;
    return rows.length;
};

// ---------- section 4e: the active semester's times (put back at the end, also after a crash) ----------
let semesterBackup = null;
const tempSemesterIds = [];
// A semester from Budapest days (admin round Group 4: opening 00:00, closing 23:59; round 2: review
// deadline 14 days after the close, 23:59); closed ones were closed after their last day
const INSERT_SEMESTER_SQL = `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date, closed_at)
    VALUES ($1, $5::varchar, $2::date::timestamp AT TIME ZONE 'Europe/Budapest', ($3::date::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
            (($3::date + 14)::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', $4::date,
            CASE WHEN $5::varchar = 'closed' THEN ($4::date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' END) RETURNING id`;
const restoreSemesters = async () => {
    const done = [];
    if (semesterBackup) {
        const b = semesterBackup;
        semesterBackup = null;
        await pool.query('UPDATE semesters SET applications_open_at = $2, applications_close_at = $3, end_date = $4, close_reason = $5, last_days_warning_days = $6, review_end_at = $7 WHERE id = $1',
            [b.id, b.applications_open_at, b.applications_close_at, b.end_date, b.close_reason, b.last_days_warning_days, b.review_end_at]);
        done.push('semester times put back');
    }
    if (tempSemesterIds.length > 0) {
        // Their applications are removed first (removeTempApplications)
        const { rowCount } = await pool.query('DELETE FROM semesters WHERE id = ANY($1)', [tempSemesterIds.splice(0)]);
        done.push(`${rowCount} temporary semester(s) removed`);
    }
    return done.join(', ') || 'nothing to put back';
};

// ---------- temporary applications of sections 4d and 4e (deleted at the end, also after a crash) ----------
const tempApplicationIds = [];
const removeTempApplications = async () => {
    if (tempApplicationIds.length === 0) return 0;
    // Deleting the application also deletes its history (the only way history entries can go)
    const { rowCount } = await pool.query('DELETE FROM applications WHERE id = ANY($1)', [tempApplicationIds.splice(0)]);
    return rowCount;
};

// ---------- section 4f: reviewer access (put back at the end, also after a crash) ----------
// The test reviewer (student B's programme's) is deactivated by an accepted test invite and
// reactivated afterwards; test accounts and invites all use @security-check.invalid addresses.
const TEST_DOMAIN = '@security-check.invalid';
let reviewerBackup = null; // { reviewerId, deactivatedAt, links: [{ id, ended_at }], assignments: [{ id, assigned }] }
const restoreReviewerAccess = async () => {
    if (!reviewerBackup) return 'nothing to put back';
    const b = reviewerBackup;
    reviewerBackup = null;
    await pool.query('DELETE FROM staff_invites WHERE email LIKE $1', [`%${TEST_DOMAIN}`]);
    const testUsers = (await pool.query('SELECT id FROM users WHERE email LIKE $1', [`%${TEST_DOMAIN}`])).rows.map((r) => r.id);
    // Test reviewers' links go first (one main reviewer per programme), then the real reviewer's links and account are put back
    await pool.query("UPDATE users SET deactivated_at = now() WHERE id = ANY($1) AND role = 'reviewer'", [testUsers]);
    await pool.query('DELETE FROM staff_programmes WHERE user_id = ANY($1)', [testUsers]);
    await pool.query('DELETE FROM staff_programmes WHERE user_id = $1 AND NOT (id = ANY($2))', [b.reviewerId, b.links.map((l) => l.id)]);
    for (const link of b.links) await pool.query('UPDATE staff_programmes SET ended_at = $2 WHERE id = $1', [link.id, link.ended_at]);
    await pool.query('UPDATE users SET deactivated_at = $2 WHERE id = $1', [b.reviewerId, b.deactivatedAt]);
    for (const a of b.assignments) await pool.query('UPDATE applications SET assigned_reviewer_id = $2 WHERE id = $1', [a.id, a.assigned]);
    await pool.query('DELETE FROM acting_sessions WHERE person_id = ANY($1)', [testUsers]);
    await pool.query('UPDATE applications SET assigned_reviewer_id = NULL WHERE assigned_reviewer_id = ANY($1)', [testUsers]);
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = ANY($1)', [testUsers]);
    return `reviewer #${b.reviewerId} active again, ${rowCount} test account(s) and the test invites removed`;
};

// ---------- section 4h: a temporary student for decisions (deleted at the end, also after a crash) ----------
// Decisions email the student, so section 4h decides only on applications of a temporary student
// whose address ends in @security-check.invalid (Mailtrap catches it; no real student is emailed).
const removeTestStudents = async () => {
    await pool.query('DELETE FROM late_access WHERE email LIKE $1', [`%${TEST_DOMAIN}`]);
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'student' AND email LIKE $1", [`%${TEST_DOMAIN}`]);
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    await pool.query('DELETE FROM acting_sessions WHERE person_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM applications WHERE student_id = ANY($1)', [ids]);
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    return rowCount;
};

// ---------- section 4r: temporary extra reviewers (deleted at the end, also after a crash) ----------
const STAFF_TEST_PREFIX = 'staff-link-';
const removeTestStaff = async () => {
    const { rows } = await pool.query("SELECT id FROM users WHERE role IN ('reviewer', 'committee') AND email LIKE $1", [`${STAFF_TEST_PREFIX}%${TEST_DOMAIN}`]);
    await pool.query('DELETE FROM staff_invites WHERE email LIKE $1', [`${STAFF_TEST_PREFIX}%${TEST_DOMAIN}`]);
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    await pool.query('DELETE FROM acting_sessions WHERE person_id = ANY($1)', [ids]);
    await pool.query('UPDATE applications SET assigned_reviewer_id = NULL WHERE assigned_reviewer_id = ANY($1)', [ids]);
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]); // their links go with them
    return rowCount;
};

// ---------- section 4s: a temporary programme for sharing work (deleted at the end, also after a crash) ----------
const SHARING_PROGRAMME_PREFIX = 'SECSHR';
const removeSharingProgramme = async () => {
    const ids = (await pool.query('SELECT id FROM programmes WHERE code LIKE $1', [`${SHARING_PROGRAMME_PREFIX}%`])).rows.map((r) => r.id);
    if (ids.length === 0) return 0;
    await pool.query('DELETE FROM applications WHERE programme_id = ANY($1)', [ids]);
    await removeTestStaff();
    await removeTestStudents();
    await pool.query('DELETE FROM programmes WHERE id = ANY($1)', [ids]);
    return ids.length;
};

// ---------- section 4l: temporary admins (deleted at the end, also after a crash) ----------
const removeTestAdmins = async () => {
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'superadmin' AND email LIKE $1", [`%${TEST_DOMAIN}`]);
    await pool.query('DELETE FROM staff_invites WHERE email LIKE $1', [`%${TEST_DOMAIN}`]);
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    await pool.query('DELETE FROM acting_sessions WHERE admin_id = ANY($1)', [ids]);
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    return rowCount;
};
let adminBackup = null; // { ids } of real admins that section 4l deactivates for a moment
const restoreAdmin = async () => {
    if (!adminBackup) return;
    await pool.query('UPDATE users SET deactivated_at = NULL WHERE id = ANY($1)', [adminBackup.ids]);
    adminBackup = null;
};

// ---------- the test students' domain (admin round Group 3) ----------
// Registration only accepts listed domains. The run adds @security-check.invalid (reserved, never
// real) to the list and removes it at the end, also after a crash, unless it was there already.
const TEST_STUDENT_DOMAIN = TEST_DOMAIN.slice(1);
let addedTestDomain = false;
const ensureTestDomain = async () => {
    const { rowCount } = await pool.query('INSERT INTO allowed_domains (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING', [TEST_STUDENT_DOMAIN]);
    if (rowCount > 0) addedTestDomain = true;
};
const removeTestDomain = async () => {
    if (!addedTestDomain) return;
    await pool.query('DELETE FROM allowed_domains WHERE domain = $1', [TEST_STUDENT_DOMAIN]);
    addedTestDomain = false;
};

// ---------- section 4n: a temporary programme, semester and hidden items (put back at the end, also after a crash) ----------
const catalogueBackup = { programmeCodes: [], semesterIds: [], hiddenProgrammes: [], hiddenCourses: [] };
const restoreCatalogue = async () => {
    const b = catalogueBackup;
    if (b.hiddenProgrammes.length) await pool.query("UPDATE programmes SET status = 'active' WHERE id = ANY($1)", [b.hiddenProgrammes.splice(0)]);
    if (b.hiddenCourses.length) await pool.query("UPDATE courses SET status = 'active' WHERE id = ANY($1)", [b.hiddenCourses.splice(0)]);
    if (b.programmeCodes.length) {
        const codes = b.programmeCodes.splice(0);
        await pool.query('DELETE FROM applications WHERE programme_id IN (SELECT id FROM programmes WHERE code = ANY($1))', [codes]);
        await pool.query('DELETE FROM courses WHERE programme_id IN (SELECT id FROM programmes WHERE code = ANY($1))', [codes]);
        await pool.query('DELETE FROM programmes WHERE code = ANY($1)', [codes]);
    }
    if (b.semesterIds.length) {
        const ids = b.semesterIds.splice(0);
        await pool.query('DELETE FROM applications WHERE semester_id = ANY($1)', [ids]);
        await pool.query('DELETE FROM courses WHERE semester_id = ANY($1)', [ids]);
        await pool.query('DELETE FROM semesters WHERE id = ANY($1)', [ids]);
    }
};

// ---------- section 4p: a temporary closed semester (put back at the end, also after a crash) ----------
// The real active semester is set to setup for a moment while a temporary 2001 semester is the
// active one and gets closed; afterwards the real one is active again. The close deletes unsent
// drafts, so every draft is saved first and put back afterwards. The PDF book is removed.
const closeBackup = { realActiveId: null, tempSemesterId: null, drafts: null, bookName: null };
const restoreClose = async () => {
    const b = closeBackup;
    if (b.tempSemesterId) {
        if (b.bookName) await minioClient.removeObject(ARCHIVE_BUCKET, b.bookName).catch(() => {});
        await pool.query('DELETE FROM applications WHERE semester_id = $1', [b.tempSemesterId]);
        await pool.query('DELETE FROM semesters WHERE id = $1', [b.tempSemesterId]);
        b.tempSemesterId = null;
        b.bookName = null;
    }
    if (b.realActiveId) {
        await pool.query("UPDATE semesters SET status = 'active' WHERE id = $1 AND status = 'setup' AND NOT EXISTS (SELECT 1 FROM semesters WHERE status = 'active')", [b.realActiveId]);
        b.realActiveId = null;
    }
    if (b.drafts) {
        for (const d of b.drafts) {
            await pool.query(
                'INSERT INTO application_drafts (student_id, version, data, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (student_id) DO NOTHING',
                [d.student_id, d.version, d.data, d.updated_at]
            );
        }
        b.drafts = null;
    }
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

// Sends a multipart form (the CSV import): fields plus one file
const callForm = async (path, { token, fields = {}, file = null, fileName = 'catalogue.csv' } = {}) => {
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => body.append(key, String(value)));
    if (file !== null) body.append('file', new Blob([file], { type: 'text/csv' }), fileName);
    const res = await fetch(`${API}/${path}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, code: json && json.code, body: json };
};

// Checks status (and code, if given)
const expect = async (name, request, status, code) => {
    const res = await request;
    const ok = res.status === status && (code === undefined || res.code === code);
    report(ok, name, ok ? `${status}${code ? ` ${code}` : ''}` : `got ${res.status} ${res.code || ''}, expected ${status} ${code || ''}`);
    return ok;
};

// Test tokens (never printed)
// The semester students apply in now: the current one, or before it starts the coming one (SQL, Group 3)
// The semester students apply to now: the same order as the period rule (utils/applicationPeriod.js)
const SEMESTER_NOW = `(SELECT id FROM semester_bounds WHERE status = 'active' OR (status = 'setup' AND opens_at > now())
    ORDER BY (status = 'active' AND opens_at <= now() AND closes_at > now()) DESC, (status = 'active' AND opens_at > now()) DESC,
             (status = 'active') DESC, CASE WHEN status = 'active' AND opens_at > now() THEN opens_at END ASC NULLS LAST,
             CASE WHEN status = 'active' THEN closes_at END DESC NULLS LAST, opens_at LIMIT 1)`;

// Whether students can submit now (the application period, admin round Group 5)
const canSubmitNow = (settings) => settings.body?.submission?.canSubmit === true;

const tokenFor = (user) => signSessionToken({ id: user.id, role: user.role });
// An acting session (admin round Group 1), started through the API like the admin dashboard does
const actingTokenFor = async (adminToken, person) => (await call('POST', 'acting/start', { token: adminToken, json: { userId: person.id } })).body?.token;
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
        const stream = minioClient.listObjects(EVIDENCE_BUCKET, '', true);
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
    // A reviewer's programme: the one they are the current main reviewer of (staff_programmes, round 2 Group 1)
    const users = (await pool.query(
        `SELECT u.id, u.role, u.email, u.name, u.neptun_code, u.deactivated_at,
                COALESCE(u.programme_id, (SELECT sp.programme_id FROM staff_programmes sp
                                          WHERE sp.user_id = u.id AND sp.role = 'main' AND sp.ended_at IS NULL ORDER BY sp.id LIMIT 1)) AS programme_id
         FROM users u ORDER BY u.id`
    )).rows;
    const programmeCodes = (await pool.query('SELECT code FROM programmes ORDER BY code')).rows.map((p) => p.code);
    const apps = (await pool.query('SELECT id, student_id FROM applications ORDER BY id')).rows;
    const filesByOwner = await listFileOwners();

    const activeReviewers = users.filter((u) => u.role === 'reviewer' && !u.deactivated_at);
    const admin = users.find((u) => u.role === 'superadmin');
    // Student B: has an application and a tagged file. Student A: another student with a tagged file,
    // preferably in a DIFFERENT programme, so the cross-programme checks can run.
    // Without such a pair those checks are reported as SKIP (counted in the total), never left out silently.
    const students = users.filter((u) => u.role === 'student' && filesByOwner.has(u.id));
    const candidatesB = students.filter((u) => apps.some((a) => a.student_id === u.id));
    const pairs = candidatesB.flatMap((b) => students.filter((a) => a.id !== b.id).map((a) => ({ a, b })));
    const pair = pairs.find(({ a, b }) => a.programme_id !== b.programme_id) || pairs[0];
    const studentA = pair?.a;
    const studentB = pair?.b;

    // Reviewers only see their own programme (reviewer Group 2): "the reviewer" is student B's
    // programme's reviewer; student A's programme's reviewer (if any) is used for A's applications
    const reviewer = studentB && activeReviewers.find((u) => u.programme_id === studentB.programme_id);
    const reviewerOfA = studentA && studentA.programme_id !== studentB?.programme_id
        ? activeReviewers.find((u) => u.programme_id === studentA.programme_id) || null
        : null;

    const missing = [];
    if (!reviewer) missing.push("an active reviewer for student B's programme");
    if (!admin) missing.push('a superadmin account');
    if (!studentB) missing.push('a student with an application and an uploaded file (student B)');
    if (!studentA) missing.push('a second student with an uploaded file (student A)');
    if (missing.length) {
        console.error(`Cannot run: the database needs ${missing.join(', ')}.`);
        process.exit(1);
    }

    return {
        reviewer,
        reviewerOfA,
        admin,
        studentA,
        studentB,
        appOfB: apps.find((a) => a.student_id === studentB.id),
        fileOfB: filesByOwner.get(studentB.id)[0],
        fileOfA: filesByOwner.get(studentA.id)[0],
        filesOfA: filesByOwner.get(studentA.id),
        goneUser: { id: Math.max(...users.map((u) => u.id)) + 100000, role: 'student' },
        programmeCodes,
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
    await ensureTestDomain();
    const d = await loadTestData();
    const A = tokenFor(d.studentA);
    const B = tokenFor(d.studentB);
    const R = tokenFor(d.reviewer);
    const S = tokenFor(d.admin);
    const fileB = encodeURIComponent(d.fileOfB);

    console.log(`Security check against ${BASE}`);
    console.log(`Test users: student A #${d.studentA.id}, student B #${d.studentB.id}, reviewer #${d.reviewer.id}, superadmin #${d.admin.id}`);
    if (d.studentA.programme_id === d.studentB.programme_id) {
        console.log('WARNING: no two students with files in DIFFERENT programmes, so the cross-programme checks will be SKIPPED.');
        console.log('         Run "npm run seed:dev" (development) to create one student per programme.');
    }

    section('1. No token -> 401 NO_TOKEN');
    const protectedRoutes = [
        ['GET', 'applications/mine'], ['GET', 'applications'], ['GET', `applications/student/${d.studentB.id}`],
        ['POST', 'applications'], ['PUT', `applications/${d.appOfB.id}/status`], ['PUT', `applications/${d.appOfB.id}/resubmit`],
        ['POST', 'uploads'], ['GET', `uploads/${fileB}`], ['DELETE', `uploads/${fileB}`],
        ['GET', 'users'], ['GET', 'users/staff'], ['PUT', `users/${d.studentB.id}/language`],
        ['GET', 'pte-courses'], ['GET', 'settings/status'],
        ['GET', 'archive'], ['POST', 'archive/generate'], ['GET', 'archive/x.pdf/download'],
        ['POST', 'refresh-token'], ['GET', 'me'],
        ['POST', 'users/invites'], ['GET', 'users/invites'], ['POST', 'users/invites/1/resend'],
        ['DELETE', 'users/invites/1'], ['PUT', `users/${d.reviewer.id}/remove-reviewer`], ['PUT', `users/${d.admin.id}/deactivate-admin`],
        ['GET', 'reviewer/applications'], ['GET', 'reviewer/applications/1'],
        ['POST', 'acting/start'], ['POST', 'acting/exit'], ['GET', 'admin/reviewer-overview'],
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
    await expect('Student: term archive', call('GET', 'archive', { token: A }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: staff list', call('GET', 'users/staff', { token: R }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: generate a term book', call('POST', 'archive/generate', { token: R, json: { from: '2025-01-01', to: '2025-06-30' } }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: upload as a student', call('POST', 'uploads', { token: R }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: invite a reviewer', call('POST', 'users/invites', { token: R, json: { email: 'x@security-check.invalid', role: 'reviewer', programme_code: d.programmeCodes[0] } }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: list invites', call('GET', 'users/invites', { token: R }), 403, 'FORBIDDEN_ROLE');
    await expect('Reviewer: remove a reviewer', call('PUT', `users/${d.reviewer.id}/remove-reviewer`, { token: R }), 403, 'FORBIDDEN_ROLE');
    await expect('Student: invite a reviewer', call('POST', 'users/invites', { token: A, json: { email: 'x@security-check.invalid', role: 'reviewer', programme_code: d.programmeCodes[0] } }), 403, 'FORBIDDEN_ROLE');
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
        if (!canSubmitNow(settings)) {
            skip("A submits an application with B's file", `submissions aren't possible now (${settings.body?.submission?.state || 'closed'}), so the server stops earlier`);
        } else {
            // A's own programme's courses, those A has NOT applied for first: the submit tests must not
            // run into the one-active-application rule (Group 6), which is tested on its own further down
            const appliedByA = new Set((await pool.query(
                "SELECT target_course_code FROM applications WHERE student_id = $1 AND status = ANY($2) AND target_course_code IS NOT NULL",
                [d.studentA.id, ['pending', 'needs_info', 'approved']]
            )).rows.map((r) => r.target_course_code));
            const ownWithCodes = (await pool.query(`SELECT id, course_code FROM courses WHERE programme_id = $1 AND semester_id = ${SEMESTER_NOW} ORDER BY id`, [d.studentA.programme_id])).rows;
            const ownCourses = [
                ...ownWithCodes.filter((c) => !appliedByA.has(c.course_code.replace(/\s/g, '').toUpperCase())),
                ...ownWithCodes.filter((c) => appliedByA.has(c.course_code.replace(/\s/g, '').toUpperCase())),
            ].map((c) => c.id);
            const otherCourses = (await pool.query(
                'SELECT id FROM courses WHERE programme_id IS DISTINCT FROM $1 ORDER BY id', [d.studentA.programme_id]
            )).rows.map((c) => c.id);
            // Every submit below uses B's file (as evidence AND as grading file): if a field or course
            // check were ever broken, the file check still refuses, so these tests can never save an application
            const validForm = (overrides = {}) => ({
                institutions: [{ name: 'Security Check University', country: 'AT', grading_file: d.fileOfB }],
                // 60 ECTS: never a credit gap. B's file is also the syllabus, so the syllabus rule is met
                fulfilled_courses: [{ institution: 0, course_name: 'Security check', course_code: 'SC-1', credits: 60, credit_system: 'ECTS', grade: 'A', file: d.fileOfB, syllabus_file: d.fileOfB }],
                target_course_ids: ownCourses.slice(0, 1),
                ...overrides,
            });
            const submitForm = (body) => call('POST', 'applications', { token: A, json: body });
            const submitAs = (targetIds) => {
                const body = validForm({ target_course_ids: targetIds });
                if (targetIds === undefined) delete body.target_course_ids;
                return submitForm(body);
            };

            // Compatibility probe. Every submit test relies on the server reading the same fields as
            // this script (B's file only refuses if the server sees it). An outdated backend once saved
            // such requests. This probe is refused by EVERY version (empty target list), but only the
            // current code reports both problems with their paths; otherwise no submit test runs.
            const probe = await submitForm({
                institutions: [{ name: 'Probe University', country: 'XX', grading_file: d.fileOfB }],
                fulfilled_courses: [{ institution: 0, course_name: 'Probe', credits: 60, credit_system: 'ECTS', grade: 'A', file: d.fileOfB, syllabus_file: d.fileOfB }],
                target_course_ids: [],
                student_note: 'x'.repeat(2001),
            });
            const probeCodes = (probe.body?.errors || []).map((e) => `${e.field} ${e.code}`);
            // The newest rule (note limit, Group 7) must be there too, so an outdated server never passes
            const serverIsCurrent = probe.status === 400
                && probeCodes.includes('institutions[0].country INVALID_COUNTRY')
                && probeCodes.includes('target_course_ids INVALID_TARGET_COURSES')
                && probeCodes.includes('student_note NOTE_TOO_LONG');
            report(serverIsCurrent, 'The backend runs the current code (compatibility probe)', serverIsCurrent ? 'submit tests will run' : `${probe.status} ${probe.code}: RESTART THE BACKEND`);
            if (!serverIsCurrent) {
                console.log('WARNING: the backend answers like older code. All submit tests are SKIPPED, so nothing can be saved.');
                console.log('         Restart the backend (Ctrl+C, then node server.js) and run the check again.');
                skip('All submit tests', 'the backend runs older code (see the probe above)');
            } else {
            const withBsFile = await submitAs(ownCourses.slice(0, 1));
            report(withBsFile.status === 403 && withBsFile.code === 'FILES_NOT_OWNED', "A submits an application with B's file", `${withBsFile.status} ${withBsFile.code}`);
            const filePaths = (withBsFile.body?.errors || []).map((e) => e.field).sort().join(', ');
            report(filePaths === 'fulfilled_courses[0].file, fulfilled_courses[0].syllabus_file, institutions[0].grading_file',
                "B's file is reported at every place it was used (transcript, syllabus, grading file)", filePaths || 'no field paths');
            if (withBsFile.code === 'FILES_NOT_OWNED') {
                // Someone else's file and a file that doesn't exist must look identical, so the submit
                // route can't be used to find out which file names exist. (Runs only after the lines above
                // proved the file check refuses.)
                const missing = `no-such-file-${Date.now()}.pdf`;
                const withMissingFile = await submitForm(validForm({
                    institutions: [{ name: 'Security Check University', country: 'AT', grading_file: missing }],
                    fulfilled_courses: [{ institution: 0, course_name: 'Security check', course_code: 'SC-1', credits: 60, credit_system: 'ECTS', grade: 'A', file: missing, syllabus_file: missing }],
                }));
                const strip = (r) => JSON.stringify({ status: r.status, ...r.body });
                report(strip(withMissingFile) === strip(withBsFile),
                    "Someone else's file and a missing file get the identical answer", `${withMissingFile.status} ${withMissingFile.code}`);
            } else {
                skip("Someone else's file and a missing file get the identical answer", 'the file check did not refuse above; not risking a real submission');
            }

            // Several mistakes at once: all reported, each under its own field
            const threeMistakes = await submitForm(validForm({
                institutions: [{ name: 'Security Check University', country: 'XX', grading_file: d.fileOfB }],
                fulfilled_courses: [{ institution: 0, course_name: 'Security check', credits: 0, credit_system: 'ECTS', file: d.fileOfB }],
            }));
            const mistakePaths = (threeMistakes.body?.errors || []).map((e) => `${e.field} ${e.code}`).join(', ');
            report(threeMistakes.status === 400
                && mistakePaths === 'institutions[0].country INVALID_COUNTRY, fulfilled_courses[0].grade INVALID_GRADE, fulfilled_courses[0].credits INVALID_CREDITS'
                && threeMistakes.code === threeMistakes.body.errors[0].code && threeMistakes.body.field === threeMistakes.body.errors[0].field,
                'Three mistakes in one submit: all three reported with their fields', mistakePaths || `${threeMistakes.status} ${threeMistakes.code}`);
            // --- Group 4: every field rule, proven from both sides (B's file stays the safety net) ---
            const inst = (o = {}) => ({ name: 'Security Check University', country: 'AT', grading_file: d.fileOfB, ...o });
            const row = (o = {}) => ({ institution: 0, course_name: 'Security check', course_code: 'SC-1', credits: 5, credit_system: 'ECTS', grade: 'A', file: d.fileOfB, syllabus_file: d.fileOfB, ...o });
            const formWith = ({ institutions = [inst()], rows = [row()] } = {}) => validForm({ institutions, fulfilled_courses: rows });
            // Refused with this code at this path; the first error is also at the top level
            const fieldError = async (name, body, path, code, params) => {
                const r = await submitForm(body);
                const hit = (r.body?.errors || []).find((e) => e.field === path && e.code === code);
                const paramsOk = !params || JSON.stringify(hit?.params) === JSON.stringify(params);
                const topOk = r.body?.code === r.body?.errors?.[0]?.code && r.body?.field === r.body?.errors?.[0]?.field;
                report(r.status === 400 && !!hit && paramsOk && topOk, name,
                    hit ? `${path} ${code}${hit.params ? ' ' + JSON.stringify(hit.params) : ''}` : `${r.status} ${JSON.stringify((r.body?.errors || []).map((e) => `${e.field} ${e.code}`))}`);
            };
            // Valid on every field: gets past all field rules and stops at the file check (B's file)
            const passesFields = async (name, body) => {
                const r = await submitForm(body);
                report(r.status === 403 && r.code === 'FILES_NOT_OWNED', name, `${r.status} ${r.code}: past all field rules`);
            };

            await fieldError('Credits as text "5"', formWith({ rows: [row({ credits: '5' })] }), 'fulfilled_courses[0].credits', 'INVALID_CREDITS', { max: 60 });
            await fieldError('Credits 0', formWith({ rows: [row({ credits: 0 })] }), 'fulfilled_courses[0].credits', 'INVALID_CREDITS');
            await fieldError('Credits -1', formWith({ rows: [row({ credits: -1 })] }), 'fulfilled_courses[0].credits', 'INVALID_CREDITS');
            await fieldError('Credits 2.3 (not a 0.5 step)', formWith({ rows: [row({ credits: 2.3 })] }), 'fulfilled_courses[0].credits', 'INVALID_CREDITS');
            await fieldError('60.5 ECTS (max 60)', formWith({ rows: [row({ credits: 60.5 })] }), 'fulfilled_courses[0].credits', 'INVALID_CREDITS', { max: 60 });
            await fieldError('30.5 US credit hours (max 30)', formWith({ rows: [row({ credits: 30.5, credit_system: 'US_CREDIT_HOURS' })] }), 'fulfilled_courses[0].credits', 'INVALID_CREDITS', { max: 30 });
            await fieldError('120.5 UK credits (max 120)', formWith({ rows: [row({ credits: 120.5, credit_system: 'UK_CATS' })] }), 'fulfilled_courses[0].credits', 'INVALID_CREDITS', { max: 120 });
            await passesFields('Exactly 60 ECTS is allowed', formWith({ rows: [row({ credits: 60 })] }));
            await passesFields('Exactly 30 US credit hours is allowed', formWith({ rows: [row({ credits: 30, credit_system: 'US_CREDIT_HOURS' })] }));
            await passesFields('Exactly 120 UK credits is allowed', formWith({ rows: [row({ credits: 120, credit_system: 'UK_CATS' })] }));
            await passesFields('2.5 ECTS (a half step) is allowed', formWith({ rows: [row({ credits: 2.5 })] }));
            await fieldError('No credit system', formWith({ rows: [row({ credit_system: '' })] }), 'fulfilled_courses[0].credit_system', 'INVALID_CREDIT_SYSTEM');
            await fieldError('Unknown credit system', formWith({ rows: [row({ credit_system: 'POINTS' })] }), 'fulfilled_courses[0].credit_system', 'INVALID_CREDIT_SYSTEM');
            await fieldError('"Other" without a name', formWith({ rows: [row({ credit_system: 'OTHER' })] }), 'fulfilled_courses[0].credit_system_other', 'INVALID_CREDIT_SYSTEM_OTHER');
            await passesFields('An "Other" name sent with ECTS is accepted (and ignored)', formWith({ rows: [row({ credit_system_other: 'Ignored points' })] }));
            await fieldError('Institution without a name', formWith({ institutions: [inst({ name: '  ' })] }), 'institutions[0].name', 'INVALID_INSTITUTION_NAME');
            await fieldError('Institution without a country', formWith({ institutions: [inst({ country: '' })] }), 'institutions[0].country', 'INVALID_COUNTRY');
            await fieldError('Institution with country code XX', formWith({ institutions: [inst({ country: 'XX' })] }), 'institutions[0].country', 'INVALID_COUNTRY');
            await fieldError('Institution without a grading document', formWith({ institutions: [inst({ grading_file: '' })] }), 'institutions[0].grading_file', 'GRADING_FILE_MISSING');
            await fieldError('Same institution twice (other case and spaces)', formWith({ institutions: [inst(), inst({ name: '  security CHECK   university ' })], rows: [row(), row({ institution: 1 })] }), 'institutions[1].name', 'DUPLICATE_INSTITUTION');
            await fieldError('Institution no course uses', formWith({ institutions: [inst(), inst({ name: 'Unused University' })] }), 'institutions[1].name', 'INSTITUTION_UNUSED');
            await fieldError('Row pointing to a missing institution', formWith({ rows: [row({ institution: 5 })] }), 'fulfilled_courses[0].institution', 'INVALID_INSTITUTION_CHOICE');
            await fieldError('Row without a course name', formWith({ rows: [row({ course_name: '' })] }), 'fulfilled_courses[0].course_name', 'INVALID_COURSE_NAME');
            await fieldError('Row without a grade', formWith({ rows: [row({ grade: '' })] }), 'fulfilled_courses[0].grade', 'INVALID_GRADE');
            await fieldError('Grade of 21 characters', formWith({ rows: [row({ grade: 'g'.repeat(21) })] }), 'fulfilled_courses[0].grade', 'INVALID_GRADE', { max: 20 });
            await fieldError('Row without evidence', formWith({ rows: [row({ file: '' })] }), 'fulfilled_courses[0].file', 'EVIDENCE_MISSING');
            await fieldError('11 institutions (limit 10)', formWith({ institutions: Array.from({ length: 11 }, (_, i) => inst({ name: `University ${i}` })) }), 'institutions', 'INVALID_INSTITUTIONS', { max: 10 });
            await fieldError('21 course rows (limit 20)', formWith({ rows: Array(21).fill(row()) }), 'fulfilled_courses', 'INVALID_FULFILLED_COURSES', { max: 20 });
            // Nothing the student typed comes back in an error answer
            const marker = `ECHO-MARKER-${Date.now()}`;
            const echoed = await submitForm(formWith({ institutions: [inst({ name: marker + 'x'.repeat(200) })], rows: [row({ grade: marker })] }));
            report(echoed.status === 400 && !JSON.stringify(echoed.body).includes('ECHO-MARKER'), 'Error answers never repeat what the student typed', `${echoed.status}, ${echoed.body?.errors?.length} errors, no typed text`);
            // --- Group 5: syllabus rule (B's file stays the transcript, so nothing can be saved) ---
            const noSyllabus = (o = {}) => row({ syllabus_file: undefined, ...o });
            const syllabusPaths = async (name, body, expected) => {
                const r = await submitForm(body);
                const got = (r.body?.errors || []).filter((e) => e.code === 'SYLLABUS_REQUIRED').map((e) => e.field).join(', ');
                report(r.status === 400 && got === expected, name, got ? `SYLLABUS_REQUIRED at ${got}` : `${r.status} ${r.code}`);
            };
            await syllabusPaths('Two courses combined without syllabi', formWith({ rows: [noSyllabus({ credits: 60 }), noSyllabus({ credits: 60 })] }),
                'fulfilled_courses[0].syllabus_file, fulfilled_courses[1].syllabus_file');
            await syllabusPaths('Credits lower than the PTE course (ECTS), no syllabus', formWith({ rows: [noSyllabus({ credits: 0.5 })] }), 'fulfilled_courses[0].syllabus_file');
            await syllabusPaths('Credits not comparable (US credit hours), no syllabus', formWith({ rows: [noSyllabus({ credits: 3, credit_system: 'US_CREDIT_HOURS' })] }), 'fulfilled_courses[0].syllabus_file');
            await syllabusPaths('Two courses: only the one without a syllabus is reported', formWith({ rows: [row({ credits: 60 }), noSyllabus({ credits: 60 })] }), 'fulfilled_courses[1].syllabus_file');
            await passesFields('Enough ECTS from one course: no syllabus needed', formWith({ rows: [noSyllabus({ credits: 60 })] }));
            await expect('Old request shape (fulfilled_courses_json) is refused',
                submitForm({ fulfilled_courses_json: [{ course_name: 'x', file: d.fileOfB }], target_course_ids: ownCourses.slice(0, 1) }), 400, 'INVALID_INSTITUTIONS');
            if (otherCourses.length === 0) {
                skip("Submit with another programme's course", 'there is only one programme with courses');
            } else {
                await expect("Submit with another programme's course", submitAs([otherCourses[0]]), 400, 'COURSE_NOT_IN_PROGRAMME');
                await expect('Submit with two PTE courses (one per application)', submitAs([ownCourses[0], otherCourses[0]]), 400, 'INVALID_TARGET_COURSES');
            }
            await expect('Submit with a course id that does not exist', submitAs([2147483000]), 400, 'COURSE_NOT_IN_PROGRAMME');
            await expect('Submit without target courses', submitAs(undefined), 400, 'INVALID_TARGET_COURSES');
            const fieldCheck = await submitAs([2147483000]);
            report(fieldCheck.body?.field === 'target_course_ids', 'Course error names its field', fieldCheck.body?.field || 'no field');
            await expect('Submit with an empty course list', submitAs([]), 400, 'INVALID_TARGET_COURSES');
            await expect('Submit with course ids as text', submitAs(['1', '2']), 400, 'INVALID_TARGET_COURSES');
            await expect('Submit with two of your own PTE courses', submitAs(ownCourses.slice(0, 2)), 400, 'INVALID_TARGET_COURSES');
            // 12 copies of one own course count as 1 after removing duplicates, so they are one course
            // and reach the file check
            await expect('Duplicates are removed before the limit', submitAs(Array(12).fill(ownCourses[0])), 403, 'FILES_NOT_OWNED');

            // --- Group 7: note limits (2000 characters, counted like the browser) ---
            await fieldError('Note of 2001 characters', { ...formWith({}), student_note: 'n'.repeat(2001) }, 'student_note', 'NOTE_TOO_LONG', { max: 2000 });
            await passesFields('Note of 2000 emoji (2000 characters, although .length says 4000)', { ...formWith({}), student_note: '😀'.repeat(2000) });
            await passesFields('Note of 2000 accented letters typed as letter + accent', { ...formWith({}), student_note: 'a\u0301'.repeat(2000) });
            await fieldError('Note that is not text', { ...formWith({}), student_note: { text: 'x' } }, 'student_note', 'INVALID_NOTE');
            const longReply = await call('PUT', `applications/${d.appOfB.id}/resubmit`, { token: A, json: { student_resubmit_note: 'r'.repeat(2001), new_files: '' } });
            report(longReply.status === 400 && longReply.code === 'NOTE_TOO_LONG' && longReply.body?.field === 'student_resubmit_note',
                'Reply note of 2001 characters ("add missing info")', `${longReply.status} ${longReply.code} at ${longReply.body?.field}`);

            // --- Group 6: one active application per PTE course ---
            // Student B applies again for the course of B's own open application. The request uses A's
            // file, so even a broken duplicate check would still be refused by the file check.
            const openOfB = (await pool.query(
                "SELECT target_courses->0->>'course_id' AS course_id FROM applications WHERE student_id = $1 AND status = ANY($2) AND target_courses IS NOT NULL LIMIT 1",
                [d.studentB.id, ['pending', 'needs_info', 'approved']]
            )).rows[0];
            if (!openOfB) {
                skip('Second application for the same PTE course', 'student B has no open application');
            } else {
                const again = await call('POST', 'applications', { token: B, json: {
                    institutions: [{ name: 'Duplicate Check University', country: 'AT', grading_file: d.fileOfA }],
                    fulfilled_courses: [{ institution: 0, course_name: 'Duplicate check', credits: 60, credit_system: 'ECTS', grade: 'A', file: d.fileOfA, syllabus_file: d.fileOfA }],
                    target_course_ids: [Number(openOfB.course_id)],
                } });
                report(again.status === 409 && again.code === 'ALREADY_APPLIED' && again.body?.field === 'target_course_ids',
                    'Second application for the same PTE course', `${again.status} ${again.code} at ${again.body?.field}`);
            }
            } // end of: the backend runs the current code
        }
    }

    // /me: only ever the logged-in person, never cached, never secrets
    const ALLOWED_PROFILE_FIELDS = ['name', 'email', 'role', 'neptun_code', 'programme'];
    const meA = await call('GET', 'me', { token: A });
    report(meA.status === 200 && meA.body?.user?.email === d.studentA.email && meA.body.user.neptun_code === d.studentA.neptun_code,
        "/me returns the logged-in student's own profile", `${meA.status}`);
    const meWithId = await call('GET', `me?id=${d.studentB.id}&user_id=${d.studentB.id}`, { token: A });
    report(meWithId.body?.user?.email === d.studentA.email, "/me ignores another user's id in the address", 'still student A');
    const meB = await call('GET', 'me', { token: B });
    report(meB.body?.user?.email === d.studentB.email && meB.body.user.email !== meA.body?.user?.email, '/me with B\'s token returns B, not A');
    const extraFields = Object.keys(meA.body?.user || {}).filter((key) => !ALLOWED_PROFILE_FIELDS.includes(key));
    report(meA.body?.user && extraFields.length === 0, '/me returns no password, tokens or other hidden fields', extraFields.length ? `extra: ${extraFields.join(', ')}` : 'only name, email, role, Neptun code, programme');
    report((meA.headers.get('cache-control') || '').includes('no-store'), '/me is sent with Cache-Control: no-store', meA.headers.get('cache-control') || 'missing');

    // Course list: a student only ever sees their own programme's courses, of the current
    // (or coming) semester (Group 3)
    const courseIdsOf = async (programmeId) => (await pool.query(
        `SELECT id FROM courses WHERE programme_id = $1 AND semester_id = ${SEMESTER_NOW} ORDER BY id`, [programmeId]
    )).rows.map((c) => c.id);
    const idsIn = (res) => (res.body?.courses || []).map((c) => c.id).sort((x, y) => x - y);
    const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
    const coursesA = await call('GET', 'pte-courses', { token: A });
    const ownA = await courseIdsOf(d.studentA.programme_id);
    report(coursesA.status === 200 && same(idsIn(coursesA), ownA), "Student A sees exactly A's programme's courses", `${idsIn(coursesA).length} courses`);
    const coursesB = await call('GET', 'pte-courses', { token: B });
    report(same(idsIn(coursesB), await courseIdsOf(d.studentB.programme_id)), "Student B sees exactly B's programme's courses", `${idsIn(coursesB).length} courses`);
    if (d.studentA.programme_id === d.studentB.programme_id) {
        skip("A sees none of another programme's courses", 'students A and B are in the same programme');
        skip('Course list ignores a programme in the address', 'same reason');
    } else {
        const otherIds = await courseIdsOf(d.studentB.programme_id);
        report(!idsIn(coursesA).some((id) => otherIds.includes(id)), "A sees none of B's programme's courses");
        const programmeB = (await pool.query('SELECT code FROM programmes WHERE id = $1', [d.studentB.programme_id])).rows[0].code;
        const tricked = await call('GET', `pte-courses?programme=${programmeB}&programme_id=${d.studentB.programme_id}`, { token: A });
        report(same(idsIn(tricked), ownA), 'Course list ignores a programme in the address', "still only A's programme");
    }
    const extraCourseFields = [...new Set((coursesA.body?.courses || []).flatMap(Object.keys))]
        .filter((key) => !['id', 'course_code', 'course_name', 'credits'].includes(key));
    report(extraCourseFields.length === 0, 'Course list sends only id, code, name and credits', extraCourseFields.join(', ') || 'ok');
    const allCourses = (await pool.query('SELECT count(*)::int AS n FROM courses')).rows[0].n;
    const coursesR = await call('GET', 'pte-courses', { token: R });
    report(idsIn(coursesR).length === allCourses, 'Reviewer still sees every course (for now)', `${idsIn(coursesR).length} of ${allCourses}`);

    section('4b. File uploads (Group 5): type, size, names');
    const objectCount = async () => new Promise((resolve, reject) => {
        let n = 0;
        const stream = minioClient.listObjects(EVIDENCE_BUCKET, '', true);
        stream.on('data', () => { n += 1; });
        stream.on('end', () => resolve(n));
        stream.on('error', reject);
    });
    const created = [];
    const uploadAs = async (name, bytes, mime, kind) => {
        const form = new FormData();
        if (kind) form.append('kind', kind);
        form.append('file', new Blob([bytes], { type: mime }), name);
        try {
            const res = await fetch(`${API}/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${A}` }, body: form });
            const body = await res.json().catch(() => null);
            // Every file the server stored is deleted at the end, even one it should have refused
            // (e.g. an outdated backend accepting a fake PDF), so the check never leaves files behind
            if (body?.fileName && !created.includes(body.fileName)) created.push(body.fileName);
            return { status: res.status, code: body?.code, body };
        } catch (err) {
            return { status: 0, code: `connection closed (${err.cause?.code || err.message})` };
        }
    };
    const pdf = (size = 64) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(Math.max(0, size - 9), 0x20)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56)]);
    const MB = 1024 * 1024;
    const before = await objectCount();

    const good = await uploadAs('tantárgyleírás.pdf', pdf(), 'application/pdf');
    report(good.status === 200 && /^[0-9a-f-]{36}\.pdf$/.test(good.body?.fileName || '') && good.body?.originalName === 'tantárgyleírás.pdf',
        'A PDF is stored under a generated name, the original name is returned', `${good.status} ${good.body?.fileName} / ${good.body?.originalName}`);
    if (good.body?.fileName) {
        const res = await fetch(`${API}/uploads/${good.body.fileName}`, { headers: { Authorization: `Bearer ${A}` } });
        const disposition = res.headers.get('content-disposition') || '';
        report(disposition.includes("filename*=UTF-8''tant%C3%A1rgyle%C3%ADr%C3%A1s.pdf") && disposition.includes('filename="tant_rgyle_r_s.pdf"'),
            'A download keeps the original name, accents included', disposition);
    }
    await expect('A text file renamed to .pdf', uploadAs('fake.pdf', Buffer.from('just some text, not a PDF'), 'application/pdf'), 400, 'FILE_TYPE_NOT_ALLOWED');
    await expect('A real PNG named .pdf (content and name differ)', uploadAs('picture.pdf', png, 'application/pdf'), 400, 'FILE_TYPE_NOT_ALLOWED');
    await expect('A Word document', uploadAs('letter.docx', Buffer.from('PK\x03\x04 word'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 400, 'FILE_TYPE_NOT_ALLOWED');
    const unchangedBig = await uploadAs('grades.pdf', pdf(11 * MB), 'application/pdf');
    report(unchangedBig.status === 413 && unchangedBig.code === 'FILE_TOO_LARGE' && unchangedBig.body?.errors?.[0]?.params?.max === 10,
        'An unchanged file over 10 MB', `${unchangedBig.status} ${unchangedBig.code} max ${unchangedBig.body?.errors?.[0]?.params?.max}`);
    const highlightedBig = await uploadAs('syllabus (highlighted).pdf', pdf(11 * MB), 'application/pdf', 'highlighted');
    report(highlightedBig.status === 200, 'A highlighted file of 11 MB is allowed (limit 15 MB)', `${highlightedBig.status}`);
    const huge = await uploadAs('huge.pdf', pdf(16 * MB), 'application/pdf', 'highlighted');
    report(huge.status === 413 && huge.code === 'FILE_TOO_LARGE', 'A file over 15 MB is refused before it is read', `${huge.status} ${huge.code}`);

    for (const name of created) await call('DELETE', `uploads/${name}`, { token: A });
    report(await objectCount() === before, 'Refused uploads leave nothing in storage', `${before} files before and after (test uploads deleted)`);

    // Request bodies the server can't take are answered in the usual { error, code } format
    const bigBody = await fetch(`${API}/applications`, { method: 'POST', headers: { Authorization: `Bearer ${A}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ student_note: 'x'.repeat(200 * 1024) }) });
    const bigAnswer = await bigBody.json().catch(() => null);
    report(bigBody.status === 413 && bigAnswer?.code === 'REQUEST_TOO_LARGE', 'A request body over 100 KB gets a JSON answer', `${bigBody.status} ${bigAnswer?.code || 'not JSON'}`);
    const badJson = await fetch(`${API}/applications`, { method: 'POST', headers: { Authorization: `Bearer ${A}`, 'Content-Type': 'application/json' }, body: '{ this is not json' });
    const badAnswer = await badJson.json().catch(() => null);
    report(badJson.status === 400 && badAnswer?.code === 'INVALID_JSON', 'Broken JSON gets a JSON answer', `${badJson.status} ${badAnswer?.code || 'not JSON'}`);

    section('4c. Drafts (Group 7): only ever the student\'s own');
    const draftsTable = (await pool.query("SELECT to_regclass('public.application_drafts') AS t")).rows[0].t;
    const draftsProbe = draftsTable ? await call('GET', 'drafts/mine', { token: A }) : null;
    if (!draftsTable) {
        skip('All drafts tests', 'the application_drafts table is missing: run "npm run migrate" in backend/');
    } else if (draftsProbe.status !== 200) {
        report(false, 'The backend knows the drafts routes', `${draftsProbe.status} ${draftsProbe.code || ''}: RESTART THE BACKEND`);
        skip('All drafts tests', 'the backend runs older code');
    } else if (!canSubmitNow(await call('GET', 'settings/status', { token: A }))) {
        // Drafts are only saved while submitting is possible (Group 3)
        skip('All drafts tests', 'no open application period: create a current semester (npm run semester:create) and open submissions');
    } else {
        draftBackup = {
            ids: [d.studentA.id, d.studentB.id],
            rows: (await pool.query('SELECT * FROM application_drafts WHERE student_id = ANY($1)', [[d.studentA.id, d.studentB.id]])).rows,
        };
        for (const method of ['GET', 'PUT', 'DELETE']) await expect(`${method} /api/drafts/mine without a token`, call(method, 'drafts/mine'), 401, 'NO_TOKEN');
        await expect('Reviewer reads a draft', call('GET', 'drafts/mine', { token: R }), 403, 'FORBIDDEN_ROLE');
        await expect('Superadmin saves a draft', call('PUT', 'drafts/mine', { token: S, json: { version: 1, data: {} } }), 403, 'FORBIDDEN_ROLE');

        const marker = `DRAFT-MARKER-${Date.now()}`;
        const missingFile = `no-such-file-${Date.now()}.pdf`;
        const draftOfA = (note) => ({ version: 1, data: {
            institutions: [{ key: 'i1', name: 'Draft University', country: 'AT', grading_file: d.fileOfA }],
            rows: [{ id: 'r1', institutionKey: 'i1', course_name: 'Draft', file: d.fileOfB, syllabus_file: missingFile }],
            target_course_id: null, note,
        } });
        await expect('A saves a draft', call('PUT', 'drafts/mine', { token: A, json: draftOfA(marker) }), 200);
        const readA = await call('GET', 'drafts/mine', { token: A });
        const back = readA.body?.draft;
        report(back?.data?.note === marker && back.data.institutions[0].grading_file === d.fileOfA, 'A reads the draft back, with A\'s own file', `${readA.status}`);
        report(back?.data?.rows?.[0]?.file === null && back.data.rows[0].syllabus_file === null && back.dropped_files === 2,
            "B's file and a missing file are removed when A's draft is read", `${back?.dropped_files} removed`);
        report(back && !Object.keys(back.file_names || {}).some((name) => name !== d.fileOfA), 'Only names of A\'s own files come back', Object.keys(back?.file_names || {}).length + ' name(s)');
        report((readA.headers.get('cache-control') || '').includes('no-store'), 'Drafts are sent with Cache-Control: no-store', readA.headers.get('cache-control') || 'missing');
        const readB = await call('GET', 'drafts/mine', { token: B });
        report(readB.status === 200 && !JSON.stringify(readB.body).includes(marker), "B never gets A's draft", `${readB.status}`);
        const marker2 = `${marker}-2`;
        await call('PUT', `drafts/mine?student_id=${d.studentB.id}`, { token: A, json: { ...draftOfA(marker2), student_id: d.studentB.id } });
        const readB2 = await call('GET', 'drafts/mine', { token: B });
        report(!JSON.stringify(readB2.body).includes(marker2), "A can't write B's draft (an id in the address or body is ignored)");
        await call('DELETE', 'drafts/mine', { token: B });
        const stillA = await call('GET', 'drafts/mine', { token: A });
        report(stillA.body?.draft?.data?.note === marker2, "B deleting a draft never touches A's");

        const draftError = async (name, json, status, code, field) => {
            const r = await call('PUT', 'drafts/mine', { token: A, json });
            report(r.status === status && r.code === code && (!field || r.body?.field === field), name, `${r.status} ${r.code || ''}${r.body?.field ? ` at ${r.body.field}` : ''}`);
        };
        await draftError('Draft without a format version', { data: {} }, 400, 'INVALID_DRAFT', 'version');
        await draftError('Draft version as text', { version: '1', data: {} }, 400, 'INVALID_DRAFT', 'version');
        await draftError('Draft that is a list', { version: 1, data: [] }, 400, 'INVALID_DRAFT', 'data');
        await draftError('Draft with 11 institutions (limit 10)', { version: 1, data: { institutions: Array(11).fill({}) } }, 400, 'INVALID_DRAFT', 'data');
        await draftError('Draft with 21 course rows (limit 20)', { version: 1, data: { rows: Array(21).fill({}) } }, 400, 'INVALID_DRAFT', 'data');
        await draftError('Draft of 210 KB (limit 200 KB)', { version: 1, data: { note: 'x'.repeat(210 * 1024) } }, 413, 'DRAFT_TOO_LARGE', 'data');
        await draftError('Draft with a NUL character', { version: 1, data: { note: 'a\u0000b' } }, 400, 'INVALID_DRAFT', 'data');
        await draftError('Draft request over 256 KB', { version: 1, data: { note: 'x'.repeat(300 * 1024) } }, 413, 'REQUEST_TOO_LARGE');
        const unchanged = await call('GET', 'drafts/mine', { token: A });
        report(unchanged.body?.draft?.data?.note === marker2, 'Refused drafts never replace the saved one');
        await expect('A deletes the draft', call('DELETE', 'drafts/mine', { token: A }), 200);
        const gone = await call('GET', 'drafts/mine', { token: A });
        report(gone.status === 200 && gone.body?.draft === null, 'After deleting, there is no draft', JSON.stringify(gone.body?.draft));
        const restored = await restoreDrafts();
        console.log(`(put back ${restored} real draft(s) of students A and B)`);
    }

    section('4d. My Status and withdrawing (Groups 8 and 9): only ever the student\'s own');
    const eventsTable = (await pool.query("SELECT to_regclass('public.application_events') AS t")).rows[0].t;
    const detailProbe = eventsTable ? await call('GET', `applications/mine/${d.appOfB.id}`, { token: B }) : null;
    if (!eventsTable) {
        skip('All My Status tests', 'the application_events table is missing: run "npm run migrate" in backend/');
    } else if (detailProbe.status !== 200) {
        report(false, 'The backend knows the detail route', `${detailProbe.status} ${detailProbe.code || ''}: RESTART THE BACKEND`);
        skip('All My Status tests', 'the backend runs older code');
    } else {
        // Only the fields a student may see: an explicit list, never internal columns
        const STUDENT_FIELDS = ['decided_at', 'decided_by', 'decision_reason', 'fulfilled_courses_json', 'id', 'info_deadline', 'last_resubmitted_at',
            'pte_course_names', 'resubmit_count', 'reviewer_note', 'status', 'submitted_at', 'target_course_code', 'target_courses',
            'semester_name', 'current_semester', 'course_no_longer_offered',
            // reviewer Group 6: the final grade and the reason given with a decision (never who decided)
            'final_grade', 'decision_rationale'];
        const listB = await call('GET', 'applications/mine', { token: B });
        const extraFields = [...new Set((listB.body?.applications || []).flatMap((app) => Object.keys(app)))].filter((k) => !STUDENT_FIELDS.includes(k));
        report(listB.status === 200 && extraFields.length === 0, 'My applications list has no internal fields (reviewed_by, student_id, ...)', extraFields.join(', ') || 'none extra');
        const detail = detailProbe.body?.application || {};
        const detailExtra = Object.keys(detail).filter((k) => ![...STUDENT_FIELDS, 'institutions', 'syllabus_reasons', 'events', 'file_names'].includes(k));
        const eventExtra = [...new Set((detail.events || []).flatMap((e) => Object.keys(e)))]
            .filter((k) => !['kind', 'actor_role', 'status', 'note', 'reason_code', 'files', 'backfilled', 'created_at'].includes(k));
        report(detailExtra.length === 0 && eventExtra.length === 0, 'The detail view has no internal fields (no actor_id in the history)', [...detailExtra, ...eventExtra].join(', ') || 'none extra');
        report((detailProbe.headers.get('cache-control') || '').includes('no-store'), 'The detail view is sent with Cache-Control: no-store', detailProbe.headers.get('cache-control') || 'missing');

        const otherApp = await call('GET', `applications/mine/${d.appOfB.id}`, { token: A });
        const noApp = await call('GET', 'applications/mine/999999999', { token: A });
        report(otherApp.status === 404 && otherApp.code === 'APPLICATION_NOT_FOUND' && JSON.stringify(otherApp.body) === JSON.stringify(noApp.body),
            "A opens B's application: the same 404 as an application that doesn't exist", `${otherApp.status} ${otherApp.code || ''}`);
        await expect('Detail with an id that is not a number', call('GET', 'applications/mine/abc', { token: A }), 404, 'APPLICATION_NOT_FOUND');
        await expect('Detail without a token', call('GET', `applications/mine/${d.appOfB.id}`), 401, 'NO_TOKEN');
        await expect('Reviewer uses the student detail route', call('GET', `applications/mine/${d.appOfB.id}`, { token: R }), 403, 'FORBIDDEN_ROLE');

        // Withdrawing: every request below must be refused before anything is saved
        const statusOfB = async () => (await pool.query('SELECT status FROM applications WHERE id = $1', [d.appOfB.id])).rows[0].status;
        const before = await statusOfB();
        const withdrawOther = await call('PUT', `applications/${d.appOfB.id}/withdraw`, { token: A });
        const withdrawNone = await call('PUT', 'applications/999999999/withdraw', { token: A });
        report(withdrawOther.status === 404 && withdrawOther.code === 'APPLICATION_NOT_FOUND' && JSON.stringify(withdrawOther.body) === JSON.stringify(withdrawNone.body),
            "A withdraws B's application: the same 404 as one that doesn't exist", `${withdrawOther.status} ${withdrawOther.code || ''}`);
        report(await statusOfB() === before, "B's application is unchanged after A's attempt", before);
        await expect('Withdraw without a token', call('PUT', `applications/${d.appOfB.id}/withdraw`), 401, 'NO_TOKEN');
        await expect('Reviewer withdraws an application', call('PUT', `applications/${d.appOfB.id}/withdraw`, { token: R }), 403, 'FORBIDDEN_ROLE');
        await expect('Superadmin withdraws an application', call('PUT', `applications/${d.appOfB.id}/withdraw`, { token: S }), 403, 'FORBIDDEN_ROLE');
        await expect('Reviewer sets the status "withdrawn" (students only)', call('PUT', `applications/${d.appOfB.id}/status`, { token: R, json: { status: 'withdrawn', note: 'x' } }), 400, 'INVALID_STATUS');

        // Two temporary applications of student A, one rejected and one withdrawn (neither blocks
        // anything), deleted again at the end together with their history
        const closedApp = async (status) => (await pool.query(
            `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, student_note)
             VALUES ($1, $2, '[]', $3, $4, $5, 'Temporary application of the security check') RETURNING id`,
            [d.studentA.id, d.studentA.programme_id, JSON.stringify([{ course_code: 'SECCHECK', course_name: 'Security check', credits: 1 }]), 'SECCHECK', status]
        )).rows[0].id;
        const rejectedOfA = await closedApp('rejected');
        const withdrawnOfA = await closedApp('withdrawn');
        tempApplicationIds.push(rejectedOfA, withdrawnOfA);
        await expect('A withdraws own rejected application', call('PUT', `applications/${rejectedOfA}/withdraw`, { token: A }), 409, 'CANNOT_WITHDRAW');
        await expect('A withdraws own application a second time', call('PUT', `applications/${withdrawnOfA}/withdraw`, { token: A }), 409, 'CANNOT_WITHDRAW');
        // Student A's application: its own programme's reviewer (the admin if that programme has none)
        await expect(`${d.reviewerOfA ? 'Reviewer' : 'Admin'} changes a withdrawn application`,
            call('PUT', `applications/${withdrawnOfA}/status`, { token: d.reviewerOfA ? tokenFor(d.reviewerOfA) : S, json: { status: 'approved', final_grade: 4, note: 'x' } }), 409, 'APPLICATION_WITHDRAWN');
        const tempStatuses = (await pool.query('SELECT status FROM applications WHERE id = ANY($1) ORDER BY id', [[rejectedOfA, withdrawnOfA]])).rows.map((r) => r.status);
        report(tempStatuses.join() === 'rejected,withdrawn', 'The refused requests changed nothing', tempStatuses.join(', '));
        const removedTemp = await removeTempApplications();
        console.log(`(removed ${removedTemp} temporary application(s))`);

        // The history is append-only in the database itself (tried in a transaction that is rolled back)
        const hasEvents = (await pool.query('SELECT 1 FROM application_events LIMIT 1')).rows.length > 0;
        const client = hasEvents ? await pool.connect() : null;
        if (!client) skip('The database refuses changing a history entry', 'no history entries yet');
        else try {
            await client.query('BEGIN');
            const changed = await client.query('UPDATE application_events SET note = note WHERE id = (SELECT min(id) FROM application_events)')
                .then(() => 'allowed', (err) => err.message);
            report(changed.includes('append-only'), 'The database refuses changing a history entry', changed.includes('append-only') ? 'refused' : changed);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }
    }

    section('4e. Application period and semesters (Group 3)');
    // The current semester's dates are moved for each case and put back afterwards (also after a
    // crash). It never ends meanwhile, so the background job never closes anything. Without a current
    // semester, a temporary one is used. "Between semesters" is tested with a fake clock (npm test).
    const semestersTable = (await pool.query("SELECT to_regclass('public.semesters') AS t")).rows[0].t;
    const periodProbe = semestersTable ? await call('GET', 'settings/status', { token: A }) : null;
    if (!semestersTable) {
        skip('All application period tests', 'the semesters table is missing: run "npm run migrate" in backend/');
    } else if (!periodProbe.body?.submission) {
        report(false, 'The backend reports the application period', 'RESTART THE BACKEND');
        skip('All application period tests', 'the backend runs older code');
    } else {
        let semesterId = (await pool.query("SELECT id FROM semester_bounds WHERE status = 'active'")).rows[0]?.id;
        if (semesterId) {
            semesterBackup = (await pool.query('SELECT id, applications_open_at, applications_close_at, review_end_at, end_date, close_reason, last_days_warning_days FROM semesters WHERE id = $1', [semesterId])).rows[0];
        } else {
            const day = (await pool.query("SELECT (d - 10)::text AS f, (d + 20)::text AS u, (d + 40)::text AS e FROM (SELECT (now() AT TIME ZONE 'Europe/Budapest')::date AS d) t")).rows[0];
            semesterId = (await pool.query(INSERT_SEMESTER_SQL, [`Security check ${Date.now()}`, day.f, day.u, day.e, 'active'])).rows[0].id;
            tempSemesterIds.push(semesterId);
        }

        // Days relative to today in Budapest
        const setDays = (from, until, ends) => pool.query(
            `UPDATE semesters SET applications_open_at = (d + $2::int)::timestamp AT TIME ZONE 'Europe/Budapest',
                 applications_close_at = ((d + $3::int)::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', end_date = d + $4::int,
                 review_end_at = ((d + $3::int + 14)::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
                 close_reason = NULL, last_days_warning_days = 7
             FROM (SELECT (now() AT TIME ZONE 'Europe/Budapest')::date AS d) t WHERE id = $1`,
            [semesterId, from, until, ends]
        ).then(() => true, (err) => (err.code === '23P01' ? false : Promise.reject(err)));
        // closeNow: the admin's Close now (admin round Group 5; it replaced the old toggle)
        const periodCase = async (label, days, closeNow, expectedState, submitStatus, submitCode) => {
            if (!(await setDays(...days))) return skip(`Submitting ${label}`, 'those days would overlap another semester');
            if (closeNow) await expect('Close now (with a reason)', call('POST', `admin/semesters/${semesterId}/close-now`, { token: S, json: { reason: 'Security check' } }), 200);
            const status = await call('GET', 'settings/status', { token: A });
            report(status.body?.submission?.state === expectedState, `Application period ${label}: state "${expectedState}"`, status.body?.submission?.state);
            // An empty form: refused by the period check, or (when submitting is possible) by the field checks
            await expect(`Submitting ${label}`, call('POST', 'applications', { token: A, json: {} }), submitStatus, submitCode);
            if (submitStatus === 403) {
                await expect(`Saving a draft ${label}`, call('PUT', 'drafts/mine', { token: A, json: { version: 1, data: {} } }), 403, submitCode);
            }
            return undefined;
        };
        await periodCase('before it starts', [10, 20, 40], false, 'not_started', 403, 'APPLICATION_PERIOD_NOT_STARTED');
        await periodCase('during it', [-10, 20, 40], false, 'open', 400);
        await periodCase('in its last days (7 set here)', [-10, 3, 40], false, 'last_days', 400);
        await periodCase('after it (semester still running)', [-20, -1, 40], false, 'period_over', 403, 'NO_APPLICATION_PERIOD');
        await periodCase('after Close now', [-10, 20, 40], true, 'closed_by_admin', 403, 'SUBMISSIONS_CLOSED');
        await setDays(-10, 20, 40);

        // Earlier semesters: a temporary past semester with two applications of student A
        const pastId = (await pool.query(INSERT_SEMESTER_SQL, [`Security check past ${Date.now()}`, '2001-02-01', '2001-03-01', '2001-06-30', 'closed'])).rows[0].id;
        tempSemesterIds.push(pastId);
        const appliedCodes = new Set((await pool.query(
            "SELECT target_course_code FROM applications WHERE student_id = $1 AND status IN ('pending', 'needs_info', 'approved')", [d.studentA.id]
        )).rows.map((r) => r.target_course_code));
        const freeCourses = (await pool.query(
            'SELECT id, course_code FROM courses WHERE programme_id = $1 AND semester_id = $2 ORDER BY id', [d.studentA.programme_id, semesterId]
        )).rows.filter((c) => !appliedCodes.has(c.course_code.replace(/\s/g, '').toUpperCase()));
        const pastApp = async (status, code) => {
            const id = (await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, student_note, final_grade)
                 VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, 'Temporary application of the security check',
                         CASE WHEN $5::varchar = 'approved' THEN 4 END) RETURNING id`,
                [d.studentA.id, d.studentA.programme_id, JSON.stringify([{ course_code: code, course_name: 'Security check', credits: 1 }]),
                    code.replace(/\s/g, '').toUpperCase(), status, pastId]
            )).rows[0].id;
            tempApplicationIds.push(id);
            return id;
        };
        if (freeCourses.length < 2) {
            skip('Cross-semester duplicate checks', "student A needs two courses of the current semester without an open application");
            await pastApp('approved', 'SECCHECK-PAST');
        } else {
            await setDays(-10, 20, 40);
            const [approvedCourse, rejectedCourse] = freeCourses;
            await pastApp('approved', approvedCourse.course_code);
            await pastApp('rejected', rejectedCourse.course_code);
            // As in section 4, every submit uses B's file: even a broken check could never save anything
            const form = (courseId) => ({
                institutions: [{ name: 'Security Check University', country: 'AT', grading_file: d.fileOfB }],
                fulfilled_courses: [{ institution: 0, course_name: 'Security check', course_code: 'SC-1', credits: 60, credit_system: 'ECTS', grade: 'A', file: d.fileOfB, syllabus_file: d.fileOfB }],
                target_course_ids: [courseId],
            });
            await expect('A applies for a course approved in an earlier semester', call('POST', 'applications', { token: A, json: form(approvedCourse.id) }), 409, 'ALREADY_APPLIED');
            await expect('A applies for a course rejected in an earlier semester (passes, stopped at the file check)', call('POST', 'applications', { token: A, json: form(rejectedCourse.id) }), 403, 'FILES_NOT_OWNED');
        }
        const pastOfA = tempApplicationIds[tempApplicationIds.length - 1];
        const listA = await call('GET', 'applications/mine', { token: A });
        const listed = (listA.body?.applications || []).find((app) => app.id === pastOfA);
        report(listed?.current_semester === false && /^Security check past/.test(listed?.semester_name || ''), "A's earlier-semester application is listed under its semester, not as current");
        const pastByB = await call('GET', `applications/mine/${pastOfA}`, { token: B });
        report(pastByB.status === 404 && pastByB.code === 'APPLICATION_NOT_FOUND', "B opens A's earlier-semester application: 404", `${pastByB.status} ${pastByB.code || ''}`);
        await expect("B withdraws A's earlier-semester application", call('PUT', `applications/${pastOfA}/withdraw`, { token: B }), 404, 'APPLICATION_NOT_FOUND');

        const removedApps = await removeTempApplications();
        const restored = await restoreSemesters();
        console.log(`(removed ${removedApps} temporary application(s); ${restored})`);
    }

    section('4f. Reviewer access (reviewer Group 2): own programme only, invites, removal');
    {
        const programmeOfB = d.studentB.programme_id;
        const programmeOfA = d.studentA.programme_id;
        const codeOf = async (programmeId) => (await pool.query('SELECT code FROM programmes WHERE id = $1', [programmeId])).rows[0].code;
        const codeOfB = await codeOf(programmeOfB);
        let seq = 0;
        // A temporary application of student A in the given programme (deleted at the end)
        const tempApp = async (programmeId, status, fields = {}) => {
            seq += 1;
            const code = `SECR${Date.now().toString(36)}${seq}`.toUpperCase();
            const { rows } = await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, fulfilled_courses_json, target_courses, target_course_code, status,
                     student_note, supplemental_files, info_requested_at, info_deadline)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, 'Temporary application of the security check', $8,
                         CASE WHEN $7::varchar = 'needs_info' THEN now() END, CASE WHEN $7::varchar = 'needs_info' THEN now() + interval '2 days' END)
                 RETURNING id`,
                [d.studentA.id, programmeId, JSON.stringify(fields.institutions || []), JSON.stringify(fields.courses || []),
                    JSON.stringify([{ course_code: code, course_name: 'Security check', credits: 1 }]), code, status, fields.supplemental || null]
            );
            tempApplicationIds.push(rows[0].id);
            return rows[0].id;
        };

        await expect('Register with an address from an unlisted domain', call('POST', 'register', { json: { name: 'Staff', email: `nobody.${Date.now()}@unlisted.invalid`, password: 'Whatever123' } }), 400, 'EMAIL_DOMAIN_NOT_ALLOWED');

        if (programmeOfA === programmeOfB) {
            skip('Reviewer sees only their own programme (applications, status, files)', 'students A and B are in the same programme');
        } else {
            // --- Applications of another programme: missing from the list, 404 everywhere else
            const other = await tempApp(programmeOfA, 'rejected');
            const list = await call('GET', 'applications', { token: R });
            const programmes = new Set((list.body?.applications || []).map((a) => a.programme_id));
            report(list.status === 200 && !(list.body.applications || []).some((a) => a.id === other) && [...programmes].every((p) => p === programmeOfB),
                "Reviewer's list has only their own programme", `${(list.body?.applications || []).length} application(s), programmes ${[...programmes].join(',') || '-'}`);
            const ofA = await call('GET', `applications/student/${d.studentA.id}`, { token: R });
            report(ofA.status === 200 && !(ofA.body.applications || []).some((a) => a.programme_id !== programmeOfB),
                "Reviewer reads another programme's student: none of that programme's applications", `${(ofA.body?.applications || []).length} returned`);
            await expect("Reviewer opens another programme's application", call('GET', `applications/student/${d.studentA.id}/${other}`, { token: R }), 404, 'APPLICATION_NOT_FOUND');
            await expect("Reviewer changes another programme's application", call('PUT', `applications/${other}/status`, { token: R, json: { status: 'approved', final_grade: 4, note: 'x' } }), 404, 'APPLICATION_NOT_FOUND');
            const after = (await pool.query('SELECT status, decided_by FROM applications WHERE id = $1', [other])).rows[0];
            report(after.status === 'rejected' && after.decided_by === null, 'The refused change saved nothing', after.status);

            // --- Files: each place an application can name a file. In another programme's application: 404;
            // the same application moved into the reviewer's programme: 200 (so that place is really checked)
            const referenced = (await pool.query(
                `SELECT DISTINCT f FROM applications a, LATERAL (
                     SELECT c->>'file' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.fulfilled_courses_json) = 'array' THEN a.fulfilled_courses_json ELSE '[]' END) c
                     UNION SELECT c->>'syllabus_file' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.fulfilled_courses_json) = 'array' THEN a.fulfilled_courses_json ELSE '[]' END) c
                     UNION SELECT i->>'grading_file' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.institutions) = 'array' THEN a.institutions ELSE '[]' END) i
                     UNION SELECT unnest(string_to_array(replace(COALESCE(a.supplemental_files, ''), ' ', ''), ','))
                     UNION SELECT unnest(e.files) FROM application_events e WHERE e.application_id = a.id
                 ) x(f) WHERE a.programme_id = $1`, [programmeOfB]
            )).rows.map((r) => r.f);
            const freeFile = d.filesOfA.find((f) => !referenced.includes(f));
            if (!freeFile) skip("Reviewer opens another programme's files", "every file of student A is in an application of the reviewer's programme");
            else {
                const fileUrl = `uploads/${encodeURIComponent(freeFile)}`;
                await expect("Reviewer opens a file no application of their programme names", call('GET', fileUrl, { token: R }), 404, 'FILE_NOT_FOUND');
                const kinds = [
                    ['transcript (fulfilled_courses_json[].file)', { courses: [{ course_name: 'x', credits: 1, file: freeFile }] }],
                    ['syllabus (fulfilled_courses_json[].syllabus_file)', { courses: [{ course_name: 'x', credits: 1, file: null, syllabus_file: freeFile }] }],
                    ['grading system (institutions[].grading_file)', { institutions: [{ name: 'x', country: 'AT', grading_file: freeFile }] }],
                    ['old reply file (supplemental_files)', { supplemental: `other.png, ${freeFile},` }],
                    ['reply file (application_events.files)', { event: true }],
                ];
                for (const [kind, fields] of kinds) {
                    const id = await tempApp(programmeOfA, 'rejected', fields);
                    if (fields.event) {
                        await pool.query(
                            "INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note, files) VALUES ($1, 'replied', 'student', $2, 'pending', 'Security check', $3)",
                            [id, d.studentA.id, [freeFile]]
                        );
                    }
                    const outside = await call('GET', fileUrl, { token: R });
                    await pool.query('UPDATE applications SET programme_id = $2 WHERE id = $1', [id, programmeOfB]);
                    const inside = await call('GET', fileUrl, { token: R });
                    report(outside.status === 404 && inside.status === 200, `File as ${kind}: 404 from another programme, 200 from own`, `${outside.status} / ${inside.status}`);
                    await pool.query('DELETE FROM applications WHERE id = $1', [id]);
                    tempApplicationIds.splice(tempApplicationIds.indexOf(id), 1);
                }
                await expect('Superadmin opens any file', call('GET', fileUrl, { token: S }), 200);
            }

            // --- The admin acting as the reviewer (admin round Group 1): only that reviewer's programme
            const actingR = await actingTokenFor(S, d.reviewer);
            const asReviewer = await call('GET', 'applications', { token: actingR });
            const all = await call('GET', 'applications', { token: S });
            // As themselves the admin sees every programme of the active semester (admin round Group 6)
            const activeId = (await pool.query("SELECT id FROM semesters WHERE status = 'active'")).rows[0]?.id ?? null;
            const activeCount = (await pool.query('SELECT count(*)::int AS n FROM applications WHERE semester_id = $1', [activeId])).rows[0].n;
            report(asReviewer.status === 200 && (asReviewer.body.applications || []).every((a) => a.programme_id === programmeOfB)
                && (all.body?.applications || []).every((a) => a.semester_id === activeId) && (all.body?.applications || []).length === activeCount,
            "Admin acting as the reviewer sees only that programme (and, as themselves, every programme of the active semester)", `${(asReviewer.body?.applications || []).length} of ${(all.body?.applications || []).length}`);
            await call('POST', 'acting/exit', { token: actingR });
            // The old ?as_reviewer view filter is gone: it is ignored
            const ignored = await call('GET', `applications?as_reviewer=${d.reviewerOfA ? d.reviewerOfA.id : d.reviewer.id}`, { token: R });
            report(ignored.status === 200 && !(ignored.body.applications || []).some((a) => a.programme_id !== programmeOfB), 'A reviewer adding ?as_reviewer still sees only their own programme', `${ignored.status}`);
            // (An admin decision stored as "admin": section 4h, reviewer Group 6)
        }

        // --- Invites and the takeover, in student B's programme (the test reviewer is put back at the end)
        reviewerBackup = {
            reviewerId: d.reviewer.id, deactivatedAt: d.reviewer.deactivated_at,
            links: (await pool.query('SELECT id, ended_at FROM staff_programmes WHERE user_id = $1', [d.reviewer.id])).rows,
            assignments: (await pool.query('SELECT id, assigned_reviewer_id AS assigned FROM applications WHERE programme_id = $1', [programmeOfB])).rows,
        };
        const stamp = Date.now().toString(36);
        const newEmail = `invited-${stamp}${TEST_DOMAIN}`;
        const invite = (json) => call('POST', 'users/invites', { token: S, json: { role: 'reviewer', ...json } });
        const tokenOf = (link) => String(link || '').split('/invite/')[1] || '';

        await expect('Invite: programme already has a reviewer, no replace', invite({ email: newEmail, programme_code: codeOfB }), 409, 'PROGRAMME_HAS_REVIEWER');
        await expect("Invite: a student's email", invite({ email: d.studentA.email, programme_code: codeOfB, replace: true }), 409, 'EMAIL_TAKEN');
        await expect("Invite: an active reviewer's email", invite({ email: d.reviewer.email, programme_code: codeOfB, replace: true }), 409, 'EMAIL_TAKEN');
        await expect('Invite: not an email address', invite({ email: 'not an email', programme_code: codeOfB }), 400, 'INVALID_EMAIL');
        await expect('Invite: unknown programme', invite({ email: newEmail, programme_code: 'NOPE' }), 400, 'INVALID_PROGRAMME');
        // Roles come only from invites (admin round Group 2): the role-change route is gone
        await expect('Role route: make someone a reviewer (route removed)', call('PUT', `users/${d.studentA.id}/role`, { token: S, json: { newRole: 'reviewer' } }), 404);
        await expect('Role route: make someone an admin (route removed)', call('PUT', `users/${d.studentA.id}/role`, { token: S, json: { newRole: 'superadmin' } }), 404);

        const openApp = await tempApp(programmeOfB, 'needs_info');
        const decidedApp = await tempApp(programmeOfB, 'rejected');
        await pool.query("UPDATE applications SET assigned_reviewer_id = $2, decided_by = $2, decided_by_role = 'reviewer', decided_at = now() WHERE id = $1", [decidedApp, d.reviewer.id]);
        await pool.query('UPDATE applications SET assigned_reviewer_id = $2 WHERE id = $1', [openApp, d.reviewer.id]);
        const deadlineBefore = (await pool.query('SELECT info_deadline FROM applications WHERE id = $1', [openApp])).rows[0].info_deadline;

        const created = await invite({ email: ` ${newEmail.toUpperCase()} `, programme_code: codeOfB, replace: true, language: 'en' });
        const token1 = tokenOf(created.body?.link);
        report(created.status === 201 && created.body.invite.email === newEmail && token1.length === 64, 'Invite with replace: created, email lowercased, link returned to the admin', `${created.status}`);
        const stored = (await pool.query('SELECT row_to_json(i)::text AS row, token_hash FROM staff_invites i WHERE email = $1', [newEmail])).rows[0];
        report(!!stored && !stored.row.includes(token1) && stored.token_hash !== token1 && stored.token_hash.length === 64, 'The invite token is not stored in plain text', 'hash only');
        const listed = await call('GET', 'users/invites?status=sent', { token: S });
        report(listed.status === 200 && listed.body.invites.some((i) => i.email === newEmail && i.status === 'sent' && i.role === 'reviewer') && !JSON.stringify(listed.body).includes(stored.token_hash),
            'Sent invites are listed with their status, without token or hash', `${listed.body?.invites?.length} sent`);

        await expect('Before acceptance the old reviewer keeps full access', call('GET', 'applications', { token: R }), 200);
        await expect('The invite link opens', call('GET', `invites/${token1}`), 200);
        await expect('Accept: password shorter than 8 characters', call('POST', `invites/${token1}/accept`, { json: { name: 'Invited Reviewer', password: 'short' } }), 400, 'PASSWORD_TOO_SHORT');
        await expect('Accept: no name for a new account', call('POST', `invites/${token1}/accept`, { json: { password: 'LongEnough1' } }), 400, 'MISSING_FIELDS');
        await expect('Accept the invite', call('POST', `invites/${token1}/accept`, { json: { name: 'Invited Reviewer', password: 'LongEnough1' } }), 200);
        const newReviewer = (await pool.query(
            `SELECT u.id, u.role, u.programme_id AS own_programme, u.is_verified, u.deactivated_at,
                    (SELECT sp.programme_id FROM staff_programmes sp WHERE sp.user_id = u.id AND sp.role = 'main' AND sp.ended_at IS NULL) AS main_of
             FROM users u WHERE u.email = $1`, [newEmail]
        )).rows[0];
        report(newReviewer && newReviewer.role === 'reviewer' && newReviewer.main_of === programmeOfB && newReviewer.own_programme === null
            && newReviewer.is_verified && !newReviewer.deactivated_at,
            'The new account is an active, verified main reviewer of the programme (linked, no users.programme_id)', newReviewer ? `#${newReviewer.id}` : 'missing');
        await expect('The old reviewer is refused from the next request on', call('GET', 'applications', { token: R }), 401, 'REVIEWER_REMOVED');
        const moved = (await pool.query('SELECT id, assigned_reviewer_id, decided_by, info_deadline FROM applications WHERE id = ANY($1)', [[openApp, decidedApp]])).rows;
        const openRow = moved.find((r) => r.id === openApp);
        const decidedRow = moved.find((r) => r.id === decidedApp);
        report(openRow.assigned_reviewer_id === newReviewer.id && openRow.info_deadline.getTime() === deadlineBefore.getTime(),
            'The open (needs_info) application moved to the new reviewer, reply deadline unchanged', `#${openRow.assigned_reviewer_id}`);
        report(decidedRow.assigned_reviewer_id === d.reviewer.id && decidedRow.decided_by === d.reviewer.id,
            'The decided application keeps the original reviewer', `#${decidedRow.assigned_reviewer_id}`);
        await expect('A used invite link is refused', call('POST', `invites/${token1}/accept`, { json: { name: 'Again', password: 'LongEnough1' } }), 410, 'INVITE_INVALID');
        await expect('An unknown invite link is refused', call('GET', `invites/${'0'.repeat(64)}`), 410, 'INVITE_INVALID');
        const NR = tokenFor(newReviewer);
        await expect('The new reviewer reads their list', call('GET', 'applications', { token: NR }), 200);

        // Expired, resent and cancelled links
        const second = await invite({ email: `second-${stamp}${TEST_DOMAIN}`, programme_code: codeOfB, replace: true });
        const token2 = tokenOf(second.body?.link);
        await pool.query("UPDATE staff_invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [second.body?.invite?.id]);
        await expect('An expired invite link', call('GET', `invites/${token2}`), 410, 'INVITE_EXPIRED');
        await expect('Accepting an expired invite', call('POST', `invites/${token2}/accept`, { json: { name: 'Late', password: 'LongEnough1' } }), 410, 'INVITE_EXPIRED');
        const resent = await call('POST', `users/invites/${second.body?.invite?.id}/resend`, { token: S });
        const token3 = tokenOf(resent.body?.link);
        report(resent.status === 200 && token3 && token3 !== token2, 'Resend gives a new link', `${resent.status}`);
        await expect('The link from before the resend is refused', call('GET', `invites/${token2}`), 410, 'INVITE_INVALID');
        await expect('The resent link opens', call('GET', `invites/${token3}`), 200);
        await expect('Cancel the invite', call('DELETE', `users/invites/${second.body?.invite?.id}`, { token: S }), 200);
        await expect('A cancelled invite link is refused', call('GET', `invites/${token3}`), 410, 'INVITE_INVALID');
        await expect('Cancelling it again', call('DELETE', `users/invites/${second.body?.invite?.id}`, { token: S }), 404, 'INVITE_NOT_FOUND');

        // Removing the new reviewer, then inviting the same email again
        await expect('Remove-reviewer on a student', call('PUT', `users/${d.studentA.id}/remove-reviewer`, { token: S }), 400, 'NOT_A_REVIEWER');
        await expect('Remove the new reviewer', call('PUT', `users/${newReviewer.id}/remove-reviewer`, { token: S }), 200);
        await expect('The removed reviewer is refused on the next request', call('GET', 'applications', { token: NR }), 401, 'REVIEWER_REMOVED');
        await expect('The removed reviewer cannot log in', call('POST', 'login', { json: { email: newEmail, password: 'LongEnough1' } }), 403, 'REVIEWER_REMOVED');
        const unassigned = (await pool.query('SELECT assigned_reviewer_id FROM applications WHERE id = $1', [openApp])).rows[0].assigned_reviewer_id;
        report(unassigned === null, 'Their open application has no reviewer now', `${unassigned}`);
        const again = await call('PUT', `users/${newReviewer.id}/remove-reviewer`, { token: S });
        report(again.status === 200 && again.body.alreadyRemoved === true, 'Removing again changes nothing', `${again.status}`);

        const reinvite = await invite({ email: newEmail, programme_code: codeOfB });
        const token4 = tokenOf(reinvite.body?.link);
        report(reinvite.status === 201, "Re-invite a removed reviewer's email (programme has no active reviewer now)", `${reinvite.status} ${reinvite.code || ''}`);
        const shown = await call('GET', `invites/${token4}`);
        report(shown.status === 200 && shown.body.invite.existingName === 'Invited Reviewer', 'The accept page gets the existing name (read-only)', `${shown.body?.invite?.existingName}`);
        const reaccepted = await call('POST', `invites/${token4}/accept`, { json: { name: 'A Different Name', password: 'AnotherPass2' } });
        const back = (await pool.query('SELECT id, name, deactivated_at FROM users WHERE email = $1', [newEmail])).rows;
        report(reaccepted.status === 200 && reaccepted.body.reactivated === true && back.length === 1 && back[0].id === newReviewer.id
            && back[0].name === 'Invited Reviewer' && !back[0].deactivated_at,
        'Re-invite reactivates the same account, name unchanged', `#${back[0]?.id} "${back[0]?.name}"`);
        await expect('The reactivated reviewer has access again', call('GET', 'applications', { token: NR }), 200);
        const reassigned = (await pool.query('SELECT assigned_reviewer_id FROM applications WHERE id = $1', [openApp])).rows[0].assigned_reviewer_id;
        // Not a swap: the open application stays shared (the main reviewer sees everything; round 2 Group 1)
        report(reassigned === null, 'The open application stays shared after the re-invite (only a swap hands applications over)', `${reassigned}`);

        const removedApps = await removeTempApplications();
        const restored = await restoreReviewerAccess();
        console.log(`(removed ${removedApps} temporary application(s); ${restored})`);
        await expect('The original reviewer has access again', call('GET', 'applications', { token: R }), 200);
    }

    section('4g. Reviewer dashboard (reviewer Groups 3 and 4): list and details, own programme, current semester, no withdrawn');
    {
        const programmeOfB = d.studentB.programme_id;
        const programmeOfA = d.studentA.programme_id;
        const current = (await pool.query("SELECT id FROM semester_bounds WHERE status = 'active' LIMIT 1")).rows[0];
        const oldDecisions = (await pool.query("SELECT count(*)::int AS n FROM applications WHERE status IN ('approved', 'rejected') AND decided_at IS NULL")).rows[0].n;
        console.log(`(decided applications without decision columns, shown as "—": ${oldDecisions})`);

        await expect('Student opens the reviewer list', call('GET', 'reviewer/applications', { token: A }), 403, 'FORBIDDEN_ROLE');
        await expect('Superadmin opens the reviewer list (only by acting as the reviewer)', call('GET', 'reviewer/applications', { token: S }), 403, 'FORBIDDEN_ROLE');

        if (!current) skip('Reviewer list: semesters, withdrawn and other applications', 'no semester is running now');
        else {
            let seq = 0;
            const temp = async (programmeId, status, semesterId) => {
                seq += 1;
                const code = `SECL${Date.now().toString(36)}${seq}`.toUpperCase();
                const decided = status === 'approved' || status === 'rejected';
                const { rows } = await pool.query(
                    `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id,
                         decided_by_role, decided_at, info_requested_at, info_deadline, final_grade)
                     VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN $7 THEN 'admin' END, CASE WHEN $7 THEN now() END,
                             CASE WHEN $5::varchar = 'needs_info' THEN now() END, CASE WHEN $5::varchar = 'needs_info' THEN now() + interval '2 days' END,
                             CASE WHEN $5::varchar = 'approved' THEN 4 END)
                     RETURNING id`,
                    [d.studentA.id, programmeId, JSON.stringify([{ course_code: code, course_name: 'Security check list', credits: 1 }]), code, status, semesterId, decided]
                );
                tempApplicationIds.push(rows[0].id);
                return rows[0].id;
            };
            const past = (await pool.query(INSERT_SEMESTER_SQL, [`Security check past ${Date.now()}`, '2001-02-01', '2001-02-10', '2001-06-30', 'closed'])).rows[0].id;
            tempSemesterIds.push(past);

            const open = await temp(programmeOfB, 'pending', current.id);
            const decidedNow = await temp(programmeOfB, 'approved', current.id);
            const withdrawn = await temp(programmeOfB, 'withdrawn', current.id);
            const decidedPast = await temp(programmeOfB, 'rejected', past);
            const decidedNoSemester = await temp(programmeOfB, 'rejected', null);
            const otherProgramme = programmeOfA !== programmeOfB ? await temp(programmeOfA, 'pending', current.id) : null;
            // Submitted 3 days ago, replied yesterday: the reply is the last action
            await pool.query("UPDATE applications SET created_at = (now() AT TIME ZONE 'UTC') - interval '3 days' WHERE id = $1", [open]);
            await pool.query(
                "INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note, created_at) VALUES ($1, 'replied', 'student', $2, 'pending', 'Security check', now() - interval '1 day')",
                [open, d.studentA.id]
            );

            const list = await call('GET', 'reviewer/applications', { token: R });
            const rows = list.body?.applications || [];
            const ids = rows.map((r) => r.id);
            const programmes = ids.length
                ? (await pool.query('SELECT DISTINCT programme_id FROM applications WHERE id = ANY($1)', [ids])).rows.map((r) => r.programme_id)
                : [];
            report(list.status === 200 && list.body.reviewer.id === d.reviewer.id && programmes.every((p) => p === programmeOfB),
                "Reviewer list: only the reviewer's programme", `${rows.length} row(s), programmes ${programmes.join(',') || '-'}`);
            if (otherProgramme) report(!ids.includes(otherProgramme), "Another programme's application is not listed", `#${otherProgramme}`);
            report(ids.includes(open) && ids.includes(decidedNow), 'Open and current-semester decided applications are listed');
            report(!ids.includes(withdrawn), 'Withdrawn applications are not listed');
            report(!ids.includes(decidedPast) && !ids.includes(decidedNoSemester), 'Completed shows only the current semester (not an earlier one, not "before semesters")');
            const completedSemesters = rows.filter((r) => r.status === 'approved' || r.status === 'rejected').map((r) => r.semester_id);
            report(completedSemesters.every((id) => id === current.id), 'Every completed row is in the current semester', `${completedSemesters.length} completed`);
            const openRow = rows.find((r) => r.id === open);
            report(openRow?.other_count === 1, '"Other applications" counts only what the reviewer sees (same programme and semester, not withdrawn)', `${openRow?.other_count}`);
            report(openRow?.resubmit_count === 1 && openRow?.waiting_days === 1, 'The reply is the last action: Resubmitted, waiting 1 day', `${openRow?.resubmit_count} / ${openRow?.waiting_days}`);
            const decidedRow = rows.find((r) => r.id === decidedNow);
            report(decidedRow?.decided_by_role === 'admin' && !!decidedRow?.decided_at, 'A completed row says who decided and when', `${decidedRow?.decided_by_role}`);
            report(rows.every((r) => !('email' in r) && !('password' in r)), 'No email addresses or passwords in the list');

            const actingR = await actingTokenFor(S, d.reviewer);
            const asReviewer = await call('GET', 'reviewer/applications', { token: actingR });
            report(asReviewer.status === 200 && asReviewer.body.reviewer.id === d.reviewer.id
                && JSON.stringify(asReviewer.body.applications.map((r) => r.id)) === JSON.stringify(ids),
            "Admin acting as the reviewer gets exactly the reviewer's list and header", `${asReviewer.status}`);
            await call('POST', 'acting/exit', { token: actingR });
            const ignored = await call('GET', `reviewer/applications?as_reviewer=${d.reviewerOfA ? d.reviewerOfA.id : d.reviewer.id}`, { token: R });
            report(ignored.status === 200 && ignored.body.reviewer.id === d.reviewer.id, 'A reviewer adding ?as_reviewer still gets their own list', `${ignored.body?.reviewer?.id}`);

            // The list carries no details (they come from the details route, reviewer Group 4)
            report(rows.every((r) => !('fulfilled_courses_json' in r) && !('student_note' in r) && !('supplemental_files' in r) && !('institutions' in r)),
                'The list rows carry no details (courses, notes, files)', Object.keys(rows[0] || {}).length + ' fields');

            // --- Details (reviewer Group 4): own programme only, files marked as missing or not
            const missingFile = `security-check-missing-${Date.now()}.pdf`;
            await pool.query(
                `UPDATE applications SET fulfilled_courses_json = $2, institutions = $3, supplemental_files = $4 WHERE id = $1`,
                [open, JSON.stringify([{ course_name: 'Security check course', course_code: 'SC1', credits: 2.5, credit_system: 'ECTS', grade: 'A', institution: 0, file: d.fileOfA, syllabus_file: missingFile }]),
                    JSON.stringify([{ name: 'Security Check University', country: 'AT', grading_file: d.fileOfA }]), `${missingFile},`]
            );
            const details = await call('GET', `reviewer/applications/${open}`, { token: R });
            const app = details.body?.application;
            report(details.status === 200 && app?.student?.id === d.studentA.id && app.fulfilled_courses.length === 1 && app.institutions.length === 1
                && app.target_course?.course_code && app.student.programme?.code,
            'Details of an own-programme application: student, programme, target course, courses, institutions', `${details.status}`);
            report(app?.files?.[d.fileOfA]?.exists === true && app?.files?.[missingFile]?.exists === false && app?.extra_files?.includes(missingFile),
                'Every named file is listed; a missing one is marked missing', app ? Object.keys(app.files).length + ' file(s)' : '-');
            report(!JSON.stringify(details.body || {}).includes('@'), 'No email addresses in the details');
            // The history (reviewer Group 5): from application_events, with the note type from application_notes
            const reply = (app?.events || []).find((e) => e.kind === 'replied');
            report(reply?.note_type === 'resubmit' && reply?.actor_name && reply?.note === 'Security check' && !('actor_id' in reply),
                "Details carry the history: the reply with its note type and the student's name, no user ids", app ? `${app.events.length} event(s)` : '-');
            const adminEvent = await pool.query(
                "INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note) VALUES ($1, 'info_requested', 'admin', $2, 'needs_info', 'Admin question') RETURNING id",
                [open, d.admin.id]
            );
            const again = await call('GET', `reviewer/applications/${open}`, { token: R });
            const adminRow = (again.body?.application?.events || []).find((e) => String(e.id) === String(adminEvent.rows[0].id));
            report(adminRow?.actor_role === 'admin' && adminRow?.actor_name === null && adminRow?.note_type === 'reviewer',
                "An admin's step shows as Admin, without the admin's name", `${adminRow?.actor_name}`);
            if (otherProgramme) await expect("Details of another programme's application", call('GET', `reviewer/applications/${otherProgramme}`, { token: R }), 404, 'APPLICATION_NOT_FOUND');
            await expect('Details of a withdrawn application', call('GET', `reviewer/applications/${withdrawn}`, { token: R }), 404, 'APPLICATION_NOT_FOUND');
            await expect('Details of an application that does not exist', call('GET', 'reviewer/applications/999999999', { token: R }), 404, 'APPLICATION_NOT_FOUND');
            await expect('Student opens reviewer details', call('GET', `reviewer/applications/${open}`, { token: A }), 403, 'FORBIDDEN_ROLE');
            await expect('Superadmin opens reviewer details as themselves', call('GET', `reviewer/applications/${open}`, { token: S }), 403, 'FORBIDDEN_ROLE');
            const actingDetails = await actingTokenFor(S, d.reviewer);
            await expect('Superadmin acting as the reviewer opens the details', call('GET', `reviewer/applications/${open}`, { token: actingDetails }), 200);
            if (otherProgramme) {
                await expect("Superadmin acting as the reviewer: another programme's details", call('GET', `reviewer/applications/${otherProgramme}`, { token: actingDetails }), 404, 'APPLICATION_NOT_FOUND');
            }
            await call('POST', 'acting/exit', { token: actingDetails });

            const removedApps = await removeTempApplications();
            const restored = await restoreSemesters();
            console.log(`(removed ${removedApps} temporary application(s); ${restored})`);
        }
    }

    section('4h. Decisions (reviewer Group 6): allowed changes, one decision at a time, grade and reason');
    {
        const programmeOfB = d.studentB.programme_id;
        const neptun = `SC${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`.slice(0, 6);
        const student = (await pool.query(
            `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
             VALUES ('Security Check Student', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id, role, programme_id`,
            [`student-${Date.now().toString(36)}${TEST_DOMAIN}`, neptun, programmeOfB]
        )).rows[0];
        const T = tokenFor(student);
        let seq = 0;
        const appIn = async (status, programmeId = programmeOfB) => {
            seq += 1;
            const code = `SECD${Date.now().toString(36)}${seq}`.toUpperCase();
            const decided = status === 'approved' || status === 'rejected';
            const { rows } = await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status,
                     final_grade, decided_by_role, decided_at, info_requested_at, info_deadline)
                 VALUES ($1, $2, '[]', $3, $4, $5::varchar, CASE WHEN $5::varchar = 'approved' THEN 4 END,
                         CASE WHEN $6 THEN 'reviewer' END, CASE WHEN $6 THEN now() END,
                         CASE WHEN $5::varchar = 'needs_info' THEN now() END, CASE WHEN $5::varchar = 'needs_info' THEN now() + interval '2 days' END)
                 RETURNING id`,
                [student.id, programmeId, JSON.stringify([{ course_code: code, course_name: 'Decision check', credits: 3 }]), code, status, decided]
            );
            return rows[0].id;
        };
        const decide = (id, json, token = R) => call('PUT', `applications/${id}/status`, { token, json });
        const statusOf = async (id) => (await pool.query(
            'SELECT status, final_grade, decided_by, decided_by_role, decided_at, decision_rationale, info_deadline, info_deadline = info_reply_deadline(info_requested_at) AS deadline_rule FROM applications WHERE id = $1', [id]
        )).rows[0];

        // Only pending -> approved / rejected / needs_info
        const refusedFrom = { needs_info: 'WAITING_FOR_STUDENT', approved: 'ALREADY_DECIDED', rejected: 'ALREADY_DECIDED', withdrawn: 'APPLICATION_WITHDRAWN' };
        for (const [from, code] of Object.entries(refusedFrom)) {
            const id = await appIn(from);
            for (const json of [{ status: 'approved', final_grade: 4 }, { status: 'rejected', note: 'x' }, { status: 'needs_info', note: 'x' }]) {
                await expect(`From ${from} to ${json.status}`, decide(id, json), 409, code);
            }
            report((await statusOf(id)).status === from, `The refused changes left ${from} as it was`);
        }
        const pendingOne = await appIn('pending');
        await expect('Back to pending (only the student\'s reply does that)', decide(pendingOne, { status: 'pending' }), 400, 'INVALID_STATUS');
        await expect('Set withdrawn (only the student does that)', decide(pendingOne, { status: 'withdrawn' }), 400, 'INVALID_STATUS');

        // What each decision needs
        const invalid = [
            ['Approve without a grade', { status: 'approved' }, 'GRADE_REQUIRED'],
            ['Approve with grade 1', { status: 'approved', final_grade: 1 }, 'INVALID_FINAL_GRADE'],
            ['Approve with grade 6', { status: 'approved', final_grade: 6 }, 'INVALID_FINAL_GRADE'],
            ['Approve with grade 4.5', { status: 'approved', final_grade: 4.5 }, 'INVALID_FINAL_GRADE'],
            ['Approve with grade "4" as text', { status: 'approved', final_grade: '4' }, 'INVALID_FINAL_GRADE'],
            ['Reject without a reason', { status: 'rejected', note: '   ' }, 'RATIONALE_REQUIRED'],
            ['Reject with a grade', { status: 'rejected', note: 'x', final_grade: 4 }, 'GRADE_ONLY_ON_APPROVE'],
            ['Request information without a message', { status: 'needs_info' }, 'MESSAGE_REQUIRED'],
            ['A note of 2001 characters', { status: 'rejected', note: 'x'.repeat(2001) }, 'NOTE_TOO_LONG'],
        ];
        for (const [name, json, code] of invalid) await expect(name, decide(pendingOne, json), 400, code);
        report((await statusOf(pendingOne)).status === 'pending', 'The refused decisions left the application pending');

        // Two decisions at the same moment: exactly one is saved
        const both = await Promise.all([
            decide(pendingOne, { status: 'approved', final_grade: 4, note: 'Security check approval' }),
            decide(pendingOne, { status: 'approved', final_grade: 5 }, S),
        ]);
        const statuses = both.map((r) => `${r.status}${r.code ? ` ${r.code}` : ''}`).sort();
        report(statuses.join(' | ') === '200 | 409 ALREADY_DECIDED', 'Two decisions at once: one saved, the other 409 ALREADY_DECIDED', statuses.join(' | '));
        const decidedEvents = (await pool.query("SELECT count(*)::int AS n FROM application_events WHERE application_id = $1 AND kind = 'decided'", [pendingOne])).rows[0].n;
        const approvedRow = await statusOf(pendingOne);
        report(decidedEvents === 1 && approvedRow.status === 'approved' && [4, 5].includes(approvedRow.final_grade) && approvedRow.decided_at,
            'One decision in the history, saved with its grade and date', `${decidedEvents} event(s), grade ${approvedRow.final_grade}`);

        // A reviewer's approval with a note; the admin's rejection
        const approved = await appIn('pending');
        await expect('Reviewer approves with grade 4 and a note', decide(approved, { status: 'approved', final_grade: 4, note: 'Well documented.' }), 200);
        const a = await statusOf(approved);
        report(a.final_grade === 4 && a.decided_by === d.reviewer.id && a.decided_by_role === 'reviewer' && a.decision_rationale === 'Well documented.',
            'Approval saved: grade, reviewer, date and note', `${a.decided_by_role} #${a.decided_by}, grade ${a.final_grade}`);
        const rejected = await appIn('pending');
        await expect('Admin rejects with a reason', decide(rejected, { status: 'rejected', note: 'Different content.' }, S), 200);
        const r = await statusOf(rejected);
        report(r.decided_by_role === 'admin' && r.decided_by === d.admin.id && r.decided_at && r.final_grade === null && r.decision_rationale === 'Different content.',
            'An admin decision is stored as admin, with the date and reason', `${r.decided_by_role} #${r.decided_by}`);

        // Request information: the deadline, and no decision fields
        const asked = await appIn('pending');
        await expect('Reviewer requests information', decide(asked, { status: 'needs_info', note: 'Please send the syllabus.' }), 200);
        const q = await statusOf(asked);
        report(q.status === 'needs_info' && q.deadline_rule === true && q.decided_at === null && q.decided_by_role === null && q.final_grade === null,
            'Request for information: reply deadline by the rule, no decision fields', `${q.info_deadline?.toISOString?.()}`);

        // Another programme: 404 (not 409), whatever its status
        if (d.studentA.programme_id !== programmeOfB) {
            const elsewhere = await appIn('pending', d.studentA.programme_id);
            await expect("Reviewer decides another programme's application", decide(elsewhere, { status: 'approved', final_grade: 4 }), 404, 'APPLICATION_NOT_FOUND');
            report((await statusOf(elsewhere)).status === 'pending', "Another programme's application stays pending");
        } else skip("Reviewer decides another programme's application", 'students A and B are in the same programme');

        // The student sees the grade and the reason (never who decided)
        const mine = await call('GET', 'applications/mine', { token: T });
        const mineApproved = (mine.body?.applications || []).find((x) => x.id === approved);
        const mineRejected = (mine.body?.applications || []).find((x) => x.id === rejected);
        report(mineApproved?.final_grade === 4 && mineApproved?.decision_rationale === 'Well documented.' && mineRejected?.decision_rationale === 'Different content.'
            && !JSON.stringify(mine.body).includes(String(d.reviewer.name)),
        "The student's list shows the grade and the reason, not the reviewer's name", `${mineApproved?.final_grade}`);

        // The database itself refuses an approval without a grade (migration 011)
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const refused = await client.query("UPDATE applications SET status = 'approved', final_grade = NULL WHERE id = $1", [asked]).then(() => 'allowed', (err) => err.constraint || err.message);
            report(refused === 'applications_approved_has_grade', 'The database refuses an approval without a grade', refused);
        } finally {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
        }

        const removed = await removeTestStudents();
        console.log(`(removed the temporary student (${removed}) with their applications and history)`);
    }

    section('4i. Admin overview per programme (reviewer Group 7): superadmin only, no email addresses');
    {
        await expect('Overview without a token', call('GET', 'admin/reviewer-overview'), 401, 'NO_TOKEN');
        await expect('Student: admin overview', call('GET', 'admin/reviewer-overview', { token: A }), 403, 'FORBIDDEN_ROLE');
        await expect('Reviewer: admin overview', call('GET', 'admin/reviewer-overview', { token: R }), 403, 'FORBIDDEN_ROLE');
        const overview = await call('GET', 'admin/reviewer-overview', { token: S });
        const rows = overview.body?.programmes || [];
        const allowed = ['code', 'name_en', 'name_hu', 'name_de', 'reviewer', 'extras', 'pending', 'needs_info'];
        const extra = [...new Set(rows.flatMap((p) => Object.keys(p).filter((k) => !allowed.includes(k))
            .concat(p.reviewer ? Object.keys(p.reviewer).filter((k) => k !== 'name').map((k) => `reviewer.${k}`) : [])
            .concat((p.extras || []).flatMap((x) => Object.keys(x).filter((k) => !['name', 'can_assist'].includes(k)).map((k) => `extras.${k}`)))))];
        report(overview.status === 200 && rows.length > 0 && extra.length === 0 && !JSON.stringify(overview.body).includes('@'),
            'Superadmin: overview with names and numbers only (no email addresses, no ids)', extra.length ? `extra: ${extra.join(', ')}` : `${rows.length} programme(s)`);
        const counts = (await pool.query(
            `SELECT p.code, count(a.id) FILTER (WHERE a.status = 'pending')::int AS pending, count(a.id) FILTER (WHERE a.status = 'needs_info')::int AS needs_info
             FROM programmes p LEFT JOIN applications a ON a.programme_id = p.id GROUP BY p.code`
        )).rows;
        const differ = counts.filter((c) => {
            const row = rows.find((p) => p.code === c.code);
            return !row || row.pending !== c.pending || row.needs_info !== c.needs_info;
        });
        report(differ.length === 0, 'The overview counts match the database for every programme', differ.length ? `differ: ${differ.map((c) => c.code).join(', ')}` : '');
        const withoutReviewer = (await pool.query(
            `SELECT code FROM programmes p WHERE NOT EXISTS (SELECT 1 FROM staff_programmes sp JOIN users r ON r.id = sp.user_id AND r.deactivated_at IS NULL
                                                           WHERE sp.programme_id = p.id AND sp.role = 'main' AND sp.ended_at IS NULL)`
        )).rows.map((r) => r.code);
        report(rows.every((p) => (p.reviewer === null) === withoutReviewer.includes(p.code)), 'Programmes without an active reviewer are shown without one', withoutReviewer.join(', ') || 'none');
    }

    section('4j. Past semesters (reviewer group L3): read-only, own programme only, files kept');
    {
        const programmeOfB = d.studentB.programme_id; // the test reviewer's programme
        const programmeOfA = d.studentA.programme_id;
        const crossProgramme = programmeOfA !== programmeOfB;
        const stamp = Date.now().toString(36);
        const pdf = Buffer.from('%PDF-1.4\n% security check\n%%EOF\n');
        const testFiles = [];
        // A file owned by student A, stored like an upload
        const storeFile = async (label) => {
            const name = `security-check-${stamp}-${label}.pdf`;
            await minioClient.putObject(EVIDENCE_BUCKET, name, pdf, pdf.length, {
                'Content-Type': 'application/pdf', 'X-Amz-Meta-Uploader-Id': String(d.studentA.id), 'X-Amz-Meta-Uploader-Role': 'student',
            });
            testFiles.push(name);
            return name;
        };
        let seq = 0;
        const pastApp = async (programmeId, status, semesterId, file = null) => {
            seq += 1;
            const code = `SECP${stamp}${seq}`.toUpperCase();
            const decided = status === 'approved' || status === 'rejected';
            const { rows } = await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, fulfilled_courses_json, target_courses, target_course_code, status, semester_id,
                     decided_by_role, decided_at, final_grade)
                 VALUES ($1, $2, '[]', $3, $4, $5, $6::varchar, $7, CASE WHEN $8 THEN 'admin' END, CASE WHEN $8 THEN now() END,
                         CASE WHEN $6::varchar = 'approved' THEN 4 END)
                 RETURNING id`,
                [d.studentA.id, programmeId, JSON.stringify(file ? [{ course_name: 'Past semester check', credits: 1, file }] : []),
                    JSON.stringify([{ course_code: code, course_name: 'Security check past', credits: 1 }]), code, status, semesterId, decided]
            );
            tempApplicationIds.push(rows[0].id);
            return rows[0].id;
        };
        const newSemester = async (year) => {
            const { rows } = await pool.query(INSERT_SEMESTER_SQL, [`Security check L3 ${year} ${stamp}`, `${year}-02-01`, `${year}-02-10`, `${year}-06-30`, 'closed']);
            tempSemesterIds.push(rows[0].id);
            return rows[0].id;
        };

        try {
            const past = await newSemester(2002); // has applications of both programmes
            const otherOnly = await newSemester(2003); // only the other programme's
            const fileOwn = await storeFile('own');
            const fileOther = await storeFile('other');
            const decidedOwn = await pastApp(programmeOfB, 'approved', past, fileOwn);
            const pendingOwn = await pastApp(programmeOfB, 'pending', past); // left open (the job would close it)
            const withdrawnOwn = await pastApp(programmeOfB, 'withdrawn', past);
            const otherApp = crossProgramme ? await pastApp(programmeOfA, 'rejected', past, fileOther) : null;
            if (crossProgramme) await pastApp(programmeOfA, 'rejected', otherOnly);

            // The semester list
            const semesters = await call('GET', 'reviewer/semesters', { token: R });
            const pastIds = (semesters.body?.past || []).map((x) => x.id);
            report(semesters.status === 200 && pastIds.includes(past) && (!crossProgramme || !pastIds.includes(otherOnly)),
                "Past semesters: only those with the reviewer's own programme's applications", `${pastIds.length} listed`);
            await expect('Student lists the reviewer semesters', call('GET', 'reviewer/semesters', { token: A }), 403, 'FORBIDDEN_ROLE');

            // The list of a past semester
            const list = await call('GET', `reviewer/applications?semester=${past}`, { token: R });
            const ids = (list.body?.applications || []).map((r) => r.id);
            report(list.status === 200 && list.body.read_only === true && ids.includes(decidedOwn) && ids.includes(pendingOwn)
                && !ids.includes(withdrawnOwn) && (!otherApp || !ids.includes(otherApp)),
            "Past semester list: read-only, own programme only, no withdrawn", `${ids.length} row(s)`);
            // A semester in progress is a filter of the current view (round 2 Group 1), not read-only
            const currentId = (await pool.query("SELECT id FROM semester_bounds WHERE status = 'active' LIMIT 1")).rows[0]?.id;
            if (currentId) {
                const filtered = await call('GET', `reviewer/applications?semester=${currentId}`, { token: R });
                report(filtered.status === 200 && filtered.body.read_only === false && (filtered.body.applications || []).every((a) => a.semester_id === currentId),
                    'A semester in progress: its applications only, not read-only', `${filtered.status}`);
            }
            const setupId = (await pool.query("SELECT id FROM semester_bounds WHERE status = 'setup' LIMIT 1")).rows[0]?.id;
            if (setupId) await expect('A semester still in setup', call('GET', `reviewer/applications?semester=${setupId}`, { token: R }), 404, 'SEMESTER_NOT_FOUND');
            await expect('A semester id that is not a number', call('GET', 'reviewer/applications?semester=abc', { token: R }), 404, 'SEMESTER_NOT_FOUND');
            await expect('A semester that does not exist', call('GET', 'reviewer/applications?semester=999999999', { token: R }), 404, 'SEMESTER_NOT_FOUND');
            const actingPast = await actingTokenFor(S, d.reviewer);
            const asReviewer = await call('GET', `reviewer/applications?semester=${past}`, { token: actingPast });
            report(asReviewer.status === 200 && JSON.stringify((asReviewer.body?.applications || []).map((r) => r.id).sort()) === JSON.stringify([...ids].sort()),
                'Superadmin acting as the reviewer gets the same past semester list', `${asReviewer.status}`);
            await call('POST', 'acting/exit', { token: actingPast });

            // Details
            const details = await call('GET', `reviewer/applications/${decidedOwn}`, { token: R });
            report(details.status === 200 && details.body.application.read_only === true && details.body.application.semester?.id === past,
                'Past semester details open, marked read-only', `${details.status}`);
            if (otherApp) await expect("Another programme's past-semester details", call('GET', `reviewer/applications/${otherApp}`, { token: R }), 404, 'APPLICATION_NOT_FOUND');

            // No change of any kind, for anyone
            await expect('Reviewer decides a pending past-semester application', call('PUT', `applications/${pendingOwn}/status`, { token: R, json: { status: 'approved', final_grade: 4 } }), 409, 'SEMESTER_ENDED');
            await expect('Reviewer requests information on it', call('PUT', `applications/${pendingOwn}/status`, { token: R, json: { status: 'needs_info', note: 'x' } }), 409, 'SEMESTER_ENDED');
            await expect('Superadmin rejects it', call('PUT', `applications/${pendingOwn}/status`, { token: S, json: { status: 'rejected', note: 'x' } }), 409, 'SEMESTER_ENDED');
            await expect('Reviewer changes a decided past-semester application', call('PUT', `applications/${decidedOwn}/status`, { token: R, json: { status: 'rejected', note: 'x' } }), 409, 'SEMESTER_ENDED');
            await expect('The student withdraws a pending past-semester application', call('PUT', `applications/${pendingOwn}/withdraw`, { token: A }), 409, 'SEMESTER_ENDED');
            const after = (await pool.query('SELECT status FROM applications WHERE id = ANY($1) ORDER BY id', [[decidedOwn, pendingOwn]])).rows.map((r) => r.status);
            const history = (await pool.query('SELECT count(*)::int AS n FROM application_events WHERE application_id = ANY($1)', [[decidedOwn, pendingOwn]])).rows[0].n;
            report(JSON.stringify(after) === JSON.stringify(['approved', 'pending']) && history === 0, 'The refused changes saved nothing (status and history)', after.join(', '));
            if (otherApp) await expect("Reviewer decides another programme's past application", call('PUT', `applications/${otherApp}/status`, { token: R, json: { status: 'approved', final_grade: 4 } }), 404, 'APPLICATION_NOT_FOUND');

            // Files of past semesters still open, for the right reviewer only
            await expect("Reviewer opens a past-semester file of their programme", call('GET', `uploads/${encodeURIComponent(fileOwn)}`, { token: R }), 200);
            if (crossProgramme) await expect("Reviewer opens another programme's past-semester file", call('GET', `uploads/${encodeURIComponent(fileOther)}`, { token: R }), 404, 'FILE_NOT_FOUND');

            // A file a submitted application uses can't be deleted; an unused one can
            await expect('Student deletes a file used by a submitted application', call('DELETE', `uploads/${encodeURIComponent(fileOwn)}`, { token: A }), 409, 'FILE_IN_USE');
            report((await getFileOwner(fileOwn)).exists, 'The file is still there');
            const unused = await storeFile('unused');
            await expect('Student deletes an unused file of their own', call('DELETE', `uploads/${encodeURIComponent(unused)}`, { token: A }), 200);
            await expect("Student deletes another student's file", call('DELETE', `uploads/${encodeURIComponent(fileOwn)}`, { token: B }), 403, 'NOT_OWNER');
        } finally {
            const removedApps = await removeTempApplications();
            const restored = await restoreSemesters();
            for (const name of testFiles) await minioClient.removeObject(EVIDENCE_BUCKET, name).catch(() => {});
            console.log(`(removed ${removedApps} temporary application(s), ${testFiles.length} test file(s); ${restored})`);
        }
    }

    section('4k. Admin foundation (admin round Group 1): 401/403/400 on admin routes, acting as a student or reviewer');
    {
        const programmeOfB = d.studentB.programme_id;
        // 403 for students and reviewers on every admin-only route (401 without a token: section 1)
        const adminOnly = [
            ['GET', 'users'], ['GET', 'users/staff'], ['PUT', `users/${d.admin.id}/deactivate-admin`], ['POST', 'admin/semesters/1/close-now'],
            ['GET', 'archive'], ['POST', 'archive/generate'], ['GET', 'archive/x.pdf/download'], ['GET', 'admin/reviewer-overview'],
            ['POST', 'users/invites'], ['GET', 'users/invites'], ['POST', 'users/invites/1/resend'],
            ['DELETE', 'users/invites/1'], ['PUT', `users/${d.reviewer.id}/remove-reviewer`], ['POST', 'acting/start'],
        ];
        for (const [method, path] of adminOnly) {
            const json = method === 'GET' ? undefined : {};
            await expect(`Student: ${method} /api/${path}`, call(method, path, { token: A, json }), 403, 'FORBIDDEN_ROLE');
            await expect(`Reviewer: ${method} /api/${path}`, call(method, path, { token: R, json }), 403, 'FORBIDDEN_ROLE');
        }

        // 400 for bad input
        await expect('Deactivate an admin with id "abc"', call('PUT', 'users/abc/deactivate-admin', { token: S }), 400, 'INVALID_ID');
        await expect('Deactivate an admin with id "0"', call('PUT', 'users/0/deactivate-admin', { token: S }), 400, 'INVALID_ID');
        await expect('Invite with an unknown role', call('POST', 'users/invites', { token: S, json: { email: 'x@security-check.invalid', role: 'owner' } }), 400, 'INVALID_ROLE');
        await expect('The old open/close toggle is gone', call('PUT', 'settings/toggle', { token: S, json: { isOpen: false } }), 404);
        await expect('Close now with a reason that is not text', call('POST', 'admin/semesters/1/close-now', { token: S, json: { reason: 42 } }), 400, 'INVALID_REASON');
        await expect('Term book with a broken date', call('POST', 'archive/generate', { token: S, json: { from: '2026-13-01', to: '2026-12-31' } }), 400, 'INVALID_DATES');
        await expect('Term book download with a strange name', call('GET', 'archive/..%2Fsecret/download', { token: S }), 400, 'INVALID_ARCHIVE_NAME');
        await expect('Resend an invite with id "abc"', call('POST', 'users/invites/abc/resend', { token: S }), 400, 'INVALID_ID');
        await expect('Cancel an invite with id "abc"', call('DELETE', 'users/invites/abc', { token: S }), 400, 'INVALID_ID');
        await expect('Remove a reviewer with id "1.5"', call('PUT', 'users/1.5/remove-reviewer', { token: S }), 400, 'INVALID_ID');
        await expect('Invite with a broken email', call('POST', 'users/invites', { token: S, json: { email: 'not-an-email', role: 'reviewer', programme_code: d.programmeCodes[0] } }), 400);
        await expect('Act as: userId "abc"', call('POST', 'acting/start', { token: S, json: { userId: 'abc' } }), 400, 'INVALID_USER_ID');
        await expect('Act as: no userId', call('POST', 'acting/start', { token: S, json: {} }), 400, 'INVALID_USER_ID');
        await expect('Act as: a user that does not exist', call('POST', 'acting/start', { token: S, json: { userId: d.goneUser.id } }), 404, 'USER_NOT_FOUND');
        await expect('Act as: a superadmin', call('POST', 'acting/start', { token: S, json: { userId: d.admin.id } }), 400, 'CANNOT_ACT_AS_ROLE');
        await expect('Exit without acting', call('POST', 'acting/exit', { token: S }), 400, 'NOT_ACTING');

        // A temporary student (decisions and withdrawals email them; @security-check.invalid)
        const neptun = `SK${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X')}`.slice(0, 6);
        const student = (await pool.query(
            `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
             VALUES ('Security Check Acting Student', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id, role, name, programme_id`,
            [`acting-${Date.now().toString(36)}${TEST_DOMAIN}`, neptun, programmeOfB]
        )).rows[0];
        let seq = 0;
        const pendingApp = async () => {
            seq += 1;
            const code = `SECK${Date.now().toString(36)}${seq}`.toUpperCase();
            return (await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status)
                 VALUES ($1, $2, '[]', $3, $4, 'pending') RETURNING id`,
                [student.id, programmeOfB, JSON.stringify([{ course_code: code, course_name: 'Acting check', credits: 3 }]), code]
            )).rows[0].id;
        };
        const decision = async (id) => (await pool.query('SELECT decided_by, decided_by_role, reviewed_by FROM applications WHERE id = $1', [id])).rows[0];
        const lastEvent = async (id) => (await pool.query('SELECT actor_role, actor_id FROM application_events WHERE application_id = $1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
        const sessionRow = async (token) => (await pool.query('SELECT * FROM acting_sessions WHERE id = $1', [jwt.decode(token)?.acting?.sessionId || 0])).rows[0];

        // The decision record: the reviewer themselves
        const byReviewer = await pendingApp();
        await expect('Reviewer approves (grade 4)', call('PUT', `applications/${byReviewer}/status`, { token: R, json: { status: 'approved', final_grade: 4 } }), 200);
        const r1 = await decision(byReviewer);
        report(r1?.decided_by_role === 'reviewer' && r1?.decided_by === d.reviewer.id, 'A reviewer\'s approval stores reviewer + their id + date', `${r1?.decided_by_role} #${r1?.decided_by}`);
        // ... the admin as themselves
        const byAdmin = await pendingApp();
        await expect('Admin override: reject', call('PUT', `applications/${byAdmin}/status`, { token: S, json: { status: 'rejected', note: 'Admin check.' } }), 200);
        const r2 = await decision(byAdmin);
        report(r2?.decided_by_role === 'admin' && r2?.decided_by === d.admin.id, 'An admin override stores admin + the admin\'s id', `${r2?.decided_by_role} #${r2?.decided_by}`);

        // Acting as the reviewer
        const AR = await actingTokenFor(S, d.reviewer);
        report(!!AR, 'The admin can start acting as the reviewer');
        const rowR = AR ? await sessionRow(AR) : null;
        report(rowR?.admin_id === d.admin.id && rowR?.person_id === d.reviewer.id && rowR?.person_role === 'reviewer' && rowR?.started_at && !rowR?.ended_at,
            'The acting session is logged: admin, person, started, not ended', `#${rowR?.id}`);
        const header = await call('GET', 'reviewer/applications', { token: AR });
        report(header.status === 200 && header.body?.reviewer?.id === d.reviewer.id, 'Acting as the reviewer opens the reviewer\'s own dashboard', `${header.status}`);
        await expect('Acting as the reviewer: start acting again from inside', call('POST', 'acting/start', { token: AR, json: { userId: student.id } }), 403, 'FORBIDDEN_ROLE');
        await expect('Acting as the reviewer: admin-only route', call('GET', 'users/staff', { token: AR }), 403, 'FORBIDDEN_ROLE');
        const actingApproval = await pendingApp();
        await expect('Acting as the reviewer: approve (grade 5)', call('PUT', `applications/${actingApproval}/status`, { token: AR, json: { status: 'approved', final_grade: 5 } }), 200);
        const r3 = await decision(actingApproval);
        const e3 = await lastEvent(actingApproval);
        report(r3?.decided_by_role === 'admin' && r3?.decided_by === d.admin.id && r3?.reviewed_by === d.admin.id && e3?.actor_role === 'admin' && e3?.actor_id === d.admin.id,
            'An approval while acting as the reviewer is stored as admin (not the reviewer)', `${r3?.decided_by_role} #${r3?.decided_by}, event ${e3?.actor_role} #${e3?.actor_id}`);
        const refreshed = await call('POST', 'refresh-token', { token: AR });
        const refreshedActing = jwt.decode(refreshed.body?.token || '')?.acting;
        report(refreshed.status === 200 && refreshedActing?.sessionId === jwt.decode(AR).acting.sessionId && refreshedActing?.actorId === d.admin.id,
            'Refreshing an acting session keeps it an acting session', `${refreshed.status}`);

        // Acting as the student (starting a new one ends the reviewer one)
        const AT = await actingTokenFor(S, student);
        await expect('The earlier acting session ended when a new one started', call('GET', 'reviewer/applications', { token: AR }), 401, 'ACTING_ENDED');
        await expect('Acting as the student: "my applications"', call('GET', 'applications/mine', { token: AT }), 200);
        const actingWithdraw = await pendingApp();
        await expect('Acting as the student: withdraw', call('PUT', `applications/${actingWithdraw}/withdraw`, { token: AT }), 200);
        const e4 = await lastEvent(actingWithdraw);
        report(e4?.actor_role === 'admin' && e4?.actor_id === d.admin.id, 'A withdrawal while acting as the student is recorded as admin', `${e4?.actor_role} #${e4?.actor_id}`);
        await expect('Acting as the student: another student\'s application', call('GET', `applications/mine/${d.appOfB.id}`, { token: AT }), 404);

        // Exit
        const exit = await call('POST', 'acting/exit', { token: AT });
        const back = jwt.decode(exit.body?.token || '');
        report(exit.status === 200 && back?.id === d.admin.id && back?.role === 'superadmin' && !back?.acting && back?.sessionStart === jwt.decode(AT).sessionStart,
            'Exit returns the admin\'s own session (same login time)', `${exit.status}`);
        const rowT = await sessionRow(AT);
        report(!!rowT?.ended_at, 'Exit records when the acting session ended');
        await expect('The acting token after Exit', call('GET', 'applications/mine', { token: AT }), 401, 'ACTING_ENDED');
        await expect('The admin\'s token from Exit works', call('GET', 'users', { token: exit.body?.token }), 200);

        // Tokens the server did not issue, and sessions that ran out
        const forged = signSessionToken({ id: student.id, role: 'student' }, now(), { sessionId: 999999999, actorId: d.admin.id, name: 'x' });
        await expect('An acting token for a session that does not exist', call('GET', 'applications/mine', { token: forged }), 401, 'ACTING_ENDED');
        const AT2 = await actingTokenFor(S, student);
        const wrongActor = signSessionToken({ id: student.id, role: 'student' }, now(), { ...jwt.decode(AT2).acting, actorId: d.reviewer.id });
        await expect('An acting token naming another admin', call('GET', 'applications/mine', { token: wrongActor }), 401, 'ACTING_ENDED');
        const otherPerson = signSessionToken({ id: d.studentA.id, role: 'student' }, now(), jwt.decode(AT2).acting);
        await expect('An acting session used for another person', call('GET', 'applications/mine', { token: otherPerson }), 401, 'ACTING_ENDED');
        await pool.query("UPDATE acting_sessions SET started_at = now() - interval '2 hours' WHERE id = $1", [jwt.decode(AT2).acting.sessionId]);
        await expect('An acting session older than one hour', call('GET', 'applications/mine', { token: AT2 }), 401, 'ACTING_ENDED');
        report(!!(await sessionRow(AT2))?.ended_at, 'A session that ran out is closed in the log');

        // Nobody can act as a removed reviewer
        const removedReviewer = (await pool.query(
            `INSERT INTO users (name, email, password, role, is_verified, deactivated_at)
             VALUES ('Security Check Removed Reviewer', $1, 'not-a-password-hash', 'reviewer', true, now()) RETURNING id`,
            [`removed-${Date.now().toString(36)}${TEST_DOMAIN}`]
        )).rows[0];
        await expect('Act as a removed reviewer', call('POST', 'acting/start', { token: S, json: { userId: removedReviewer.id } }), 400, 'CANNOT_ACT_AS_REMOVED_REVIEWER');
        await pool.query('DELETE FROM users WHERE id = $1', [removedReviewer.id]);

        const removed = await removeTestStudents();
        console.log(`(removed the temporary student (${removed}) with their applications, history and acting sessions)`);
    }

    section('4l. Admins and reviewers (admin round Group 2): invites only, admin invites, deactivation, last admin');
    {
        const { spawnSync } = require('child_process');
        const stamp = Date.now().toString(36);
        const adminEmail = `admin-${stamp}${TEST_DOMAIN}`;
        const tokenOf = (link) => String(link || '').split('/invite/')[1] || '';
        const invite = (json) => call('POST', 'users/invites', { token: S, json });

        // Nobody becomes staff by registering
        await expect('Register from an unlisted (staff) domain', call('POST', 'register', { json: { name: 'X', email: `x-${stamp}@staff-unlisted.invalid`, password: 'LongEnough1' } }), 400, 'EMAIL_DOMAIN_NOT_ALLOWED');
        await expect('Register from a subdomain of a listed domain', call('POST', 'register', { json: { name: 'X', email: `x-${stamp}@sub.${TEST_STUDENT_DOMAIN}`, password: 'LongEnough1' } }), 400, 'EMAIL_DOMAIN_NOT_ALLOWED');
        report((await pool.query('SELECT count(*)::int AS n FROM users WHERE email LIKE $1', [`x-${stamp}@%`])).rows[0].n === 0, 'No account was created by those registrations');
        await expect('The role-change route is gone', call('PUT', `users/${d.studentA.id}/role`, { token: S, json: { newRole: 'superadmin' } }), 404);

        // Invite input
        await expect('Admin invite with a programme', invite({ email: adminEmail, role: 'superadmin', programme_code: d.programmeCodes[0] }), 400, 'PROGRAMME_ONLY_FOR_REVIEWERS');
        await expect('Admin invite with replace', invite({ email: adminEmail, role: 'superadmin', replace: true }), 400, 'PROGRAMME_ONLY_FOR_REVIEWERS');
        await expect('Reviewer invite without a programme', invite({ email: adminEmail, role: 'reviewer' }), 400, 'INVALID_PROGRAMME');
        await expect('Invite without a role', invite({ email: adminEmail }), 400, 'INVALID_ROLE');
        await expect('Invite with an unknown language', invite({ email: adminEmail, role: 'superadmin', language: 'fr' }), 400, 'UNSUPPORTED_LANGUAGE');
        await expect("Admin invite to an active admin's email", invite({ email: d.admin.email, role: 'superadmin' }), 409, 'EMAIL_TAKEN');
        await expect("Admin invite to a student's email", invite({ email: d.studentA.email, role: 'superadmin' }), 409, 'EMAIL_TAKEN');
        await expect('Invite list with an unknown status', call('GET', 'users/invites?status=open', { token: S }), 400, 'INVALID_STATUS');

        // An admin invite
        const created = await invite({ email: adminEmail, role: 'superadmin', language: 'en' });
        const token1 = tokenOf(created.body?.link);
        report(created.status === 201 && created.body.invite.role === 'superadmin' && Array.isArray(created.body.invite.programmes) && created.body.invite.programmes.length === 0 && created.body.invite.status === 'sent',
            'Admin invite: created, no programme, status sent', `${created.status} ${created.code || ''}`);
        const page = await call('GET', `invites/${token1}`);
        report(page.status === 200 && page.body.invite.role === 'superadmin' && Array.isArray(page.body.invite.programmes) && page.body.invite.programmes.length === 0, 'The accept page shows an admin invite without a programme', `${page.status}`);
        await expect('Accept the admin invite', call('POST', `invites/${token1}/accept`, { json: { name: 'Security Check Admin', password: 'LongEnough1' } }), 200);
        const newAdmin = (await pool.query('SELECT id, role, programme_id, is_verified, deactivated_at FROM users WHERE email = $1', [adminEmail])).rows[0];
        report(newAdmin?.role === 'superadmin' && newAdmin.programme_id === null && newAdmin.is_verified && !newAdmin.deactivated_at,
            'The new account is an active, verified admin', newAdmin ? `#${newAdmin.id}` : 'missing');
        const accepted = await call('GET', 'users/invites?status=accepted', { token: S });
        report((accepted.body?.invites || []).some((i) => i.email === adminEmail && i.status === 'accepted'), 'The invite now shows as accepted');
        const N = tokenFor(newAdmin);
        await expect('The new admin reads the staff list', call('GET', 'users/staff', { token: N }), 200);
        const staffList = await call('GET', 'users/staff', { token: S });
        const self = (staffList.body?.staff || []).find((p) => p.id === d.admin.id);
        report(self?.is_self === true && (staffList.body?.staff || []).every((p) => ['reviewer', 'superadmin'].includes(p.role)), 'The staff list has reviewers and admins only, and marks yourself');
        await expect('A reviewer cannot remove themselves', call('PUT', `users/${d.reviewer.id}/remove-reviewer`, { token: R }), 403, 'FORBIDDEN_ROLE');

        // Deactivating admins
        await expect('Deactivate yourself', call('PUT', `users/${d.admin.id}/deactivate-admin`, { token: S }), 400, 'CANNOT_DEACTIVATE_SELF');
        await expect('Deactivate-admin on a reviewer', call('PUT', `users/${d.reviewer.id}/deactivate-admin`, { token: S }), 400, 'NOT_AN_ADMIN');
        await expect('Deactivate-admin on a user that does not exist', call('PUT', `users/${d.goneUser.id}/deactivate-admin`, { token: S }), 404, 'USER_NOT_FOUND');
        const actingN = await actingTokenFor(N, d.studentA);
        await expect('Deactivate the new admin', call('PUT', `users/${newAdmin.id}/deactivate-admin`, { token: S }), 200);
        await expect('The deactivated admin is refused on the next request', call('GET', 'users/staff', { token: N }), 401, 'ACCOUNT_DEACTIVATED');
        await expect('The deactivated admin cannot log in', call('POST', 'login', { json: { email: adminEmail, password: 'LongEnough1' } }), 403, 'ACCOUNT_DEACTIVATED');
        await expect("The deactivated admin's acting session ends", call('GET', 'applications/mine', { token: actingN }), 401, 'ACTING_ENDED');
        const again = await call('PUT', `users/${newAdmin.id}/deactivate-admin`, { token: S });
        report(again.status === 200 && again.body.alreadyDeactivated === true, 'Deactivating again changes nothing', `${again.status}`);

        // Reactivation: same account, same id, new password
        await expect('Invite a deactivated admin as a reviewer', invite({ email: adminEmail, role: 'reviewer', programme_code: d.programmeCodes[0], replace: true }), 409, 'EMAIL_TAKEN_OTHER_ROLE');
        const reinvite = await invite({ email: adminEmail, role: 'superadmin' });
        const token2 = tokenOf(reinvite.body?.link);
        const shown = await call('GET', `invites/${token2}`);
        report(reinvite.status === 201 && shown.body?.invite?.existingName === 'Security Check Admin', 'Re-invite a deactivated admin: the accept page keeps the name', `${reinvite.status}`);
        const reaccepted = await call('POST', `invites/${token2}/accept`, { json: { password: 'AnotherPass2' } });
        const back = (await pool.query('SELECT id, deactivated_at FROM users WHERE email = $1', [adminEmail])).rows;
        report(reaccepted.status === 200 && reaccepted.body.reactivated === true && back.length === 1 && back[0].id === newAdmin.id && !back[0].deactivated_at,
            'Re-invite reactivates the same admin account (same id)', `#${back[0]?.id}`);
        await expect('The reactivated admin logs in with the new password', call('POST', 'login', { json: { email: adminEmail, password: 'AnotherPass2' } }), 200);
        await expect('The old password no longer works', call('POST', 'login', { json: { email: adminEmail, password: 'LongEnough1' } }), 401, 'INVALID_CREDENTIALS');

        // The last admin: two admins deactivating each other at the same moment leave one
        const otherActive = (await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL AND id NOT IN ($1, $2)", [d.admin.id, newAdmin.id])).rows[0].n;
        if (otherActive > 0) {
            skip('Two admins deactivating each other', `${otherActive} other active admin(s) in this database`);
        } else {
            adminBackup = { ids: [d.admin.id] };
            const [one, two] = await Promise.all([
                call('PUT', `users/${newAdmin.id}/deactivate-admin`, { token: S }),
                call('PUT', `users/${d.admin.id}/deactivate-admin`, { token: tokenFor(newAdmin) }),
            ]);
            const left = (await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL")).rows[0].n;
            const wins = [one, two].filter((r) => r.status === 200).length;
            const refusal = [one, two].find((r) => r.status !== 200);
            report(wins === 1 && left === 1 && ['LAST_ADMIN', 'ACCOUNT_DEACTIVATED'].includes(refusal?.code),
                'Two admins deactivating each other: exactly one succeeds, one admin stays active', `${one.status} ${one.code || ''} / ${two.status} ${two.code || ''}, active ${left}`);
            await restoreAdmin();
        }

        // The admin list shows which programmes have no reviewer (the admin decides those)
        const apps = await call('GET', 'applications', { token: S });
        report(apps.status === 200 && (apps.body.applications || []).every((a) => typeof a.programme_has_reviewer === 'boolean'),
            'The admin application list says whether each programme has an active reviewer');

        // First-admin script: only while no active admin exists, address from the command line or FIRST_ADMIN_EMAIL
        const script = (args, env = {}) => spawnSync(process.execPath, ['admin.js', ...args], { cwd: `${__dirname}/..`, env: { ...process.env, ...env }, encoding: 'utf8' });
        const noEmail = script([], { FIRST_ADMIN_EMAIL: '' });
        report(noEmail.status === 1 && /Usage/.test(noEmail.stderr), 'First-admin script without an address: usage, nothing created');
        const withAdmin = script([`first-${stamp}${TEST_DOMAIN}`]);
        const withEnv = script([], { FIRST_ADMIN_EMAIL: `first-${stamp}${TEST_DOMAIN}` });
        const firstInvites = (await pool.query('SELECT count(*)::int AS n FROM staff_invites WHERE email = $1', [`first-${stamp}${TEST_DOMAIN}`])).rows[0].n;
        report(withAdmin.status === 1 && withEnv.status === 1 && /already exists/.test(withAdmin.stderr) && firstInvites === 0,
            'First-admin script refuses while an active admin exists (argument and FIRST_ADMIN_EMAIL)', `${withAdmin.status} / ${withEnv.status}`);
        // With no active admin (all switched off for a moment, put back right after, also after a crash)
        const activeIds = (await pool.query("SELECT id FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL")).rows.map((r) => r.id);
        adminBackup = { ids: activeIds };
        try {
            await pool.query('UPDATE users SET deactivated_at = now() WHERE id = ANY($1)', [activeIds]);
            const firstEmail = `first-${stamp}${TEST_DOMAIN}`;
            const ok = script([], { FIRST_ADMIN_EMAIL: firstEmail.toUpperCase() });
            const firstLink = (ok.stdout.match(/\/invite\/([0-9a-f]{64})/) || [])[1];
            const row = (await pool.query(
                `SELECT i.role, i.invited_by, (SELECT count(*)::int FROM staff_invite_programmes ip WHERE ip.invite_id = i.id) AS programmes
                 FROM staff_invites i WHERE i.email = $1 AND i.accepted_at IS NULL AND i.cancelled_at IS NULL`, [firstEmail]
            )).rows[0];
            report(ok.status === 0 && !!firstLink && row?.role === 'superadmin' && row.programmes === 0,
                'First-admin script with no active admin: creates an admin invite and prints its link', `${ok.status}`);
            const firstPage = firstLink ? await call('GET', `invites/${firstLink}`) : { status: 0 };
            report(firstPage.status === 200 && firstPage.body.invite.role === 'superadmin', 'The printed link opens the admin accept page', `${firstPage.status}`);
        } finally {
            await restoreAdmin();
        }

        const removed = await removeTestAdmins();
        console.log(`(removed ${removed} temporary admin(s) and their invites)`);
    }

    section('4m. Students and domains (admin round Group 3): allowed domains, registration, programme change');
    {
        const stamp = Date.now().toString(36);
        const domains = () => call('GET', 'admin/domains', { token: S });
        const adminOnly = [['GET', 'admin/domains'], ['POST', 'admin/domains'], ['DELETE', 'admin/domains/1'], ['GET', 'admin/students?q=ab'],
            ['GET', 'admin/students/1/programme-changes'], ['PUT', 'admin/students/1/programme']];
        for (const [method, path] of adminOnly) {
            await expect(`No token: ${method} /api/${path}`, call(method, path), 401, 'NO_TOKEN');
            await expect(`Student: ${method} /api/${path}`, call(method, path, { token: A, json: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN_ROLE');
            await expect(`Reviewer: ${method} /api/${path}`, call(method, path, { token: R, json: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN_ROLE');
        }

        // Domain format, checked on the server
        for (const bad of ['', 'no-dot', 'has space.example', '*.example', 'a..example', '-bad.example', 'user@host.example', 'x'.repeat(250) + '.example']) {
            await expect(`Add domain "${bad.length > 30 ? `${bad.slice(0, 20)}…` : bad}"`, call('POST', 'admin/domains', { token: S, json: { domain: bad } }), 400, 'INVALID_DOMAIN');
        }
        await expect('Add a domain that is not text', call('POST', 'admin/domains', { token: S, json: { domain: 42 } }), 400, 'INVALID_DOMAIN');
        await expect('Add the test domain again', call('POST', 'admin/domains', { token: S, json: { domain: ` @${TEST_STUDENT_DOMAIN.toUpperCase()} ` } }), 409, 'DOMAIN_EXISTS');
        await expect('Remove a domain with id "abc"', call('DELETE', 'admin/domains/abc', { token: S }), 400, 'INVALID_ID');
        await expect('Remove a domain that does not exist', call('DELETE', 'admin/domains/999999999', { token: S }), 404, 'DOMAIN_NOT_FOUND');

        // Registration: only from a listed domain, always a student
        const neptun = `S${stamp.slice(-5).toUpperCase().padStart(5, 'X')}`.slice(0, 6).replace(/[^A-Z0-9]/g, 'X');
        const email = `domain-${stamp}${TEST_DOMAIN}`;
        const registered = await call('POST', 'register', { json: { name: 'Domain Check Student', email, password: 'LongEnough1', neptun_code: neptun, programme_code: d.programmeCodes[0], role: 'superadmin', language: 'en' } });
        const account = (await pool.query('SELECT id, role, programme_id FROM users WHERE email = $1', [email])).rows[0];
        report(registered.status === 200 && account?.role === 'student', 'Register from a listed domain: a student (a "role" in the request is ignored)', `${registered.status} ${account?.role}`);

        const listed = await domains();
        const testDomain = (listed.body?.domains || []).find((row) => row.domain === TEST_STUDENT_DOMAIN);
        report(listed.status === 200 && !!testDomain, 'The domain list shows the test domain', `${listed.status}`);
        await expect('Remove the test domain', call('DELETE', `admin/domains/${testDomain?.id}`, { token: S }), 200);
        addedTestDomain = false; // removed through the API; added back below
        const blocked = `domain2-${stamp}${TEST_DOMAIN}`;
        await expect('Register after the domain was removed', call('POST', 'register', { json: { name: 'Late', email: blocked, password: 'LongEnough1', neptun_code: 'ZZZ998', programme_code: d.programmeCodes[0] } }), 400, 'EMAIL_DOMAIN_NOT_ALLOWED');
        report((await pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [blocked])).rows[0].n === 0, 'Nothing was created for the refused registration');
        await pool.query('UPDATE users SET is_verified = true WHERE id = $1', [account?.id || 0]);
        await expect('An existing account from the removed domain still logs in', call('POST', 'login', { json: { email, password: 'LongEnough1' } }), 200);
        const readded = await call('POST', 'admin/domains', { token: S, json: { domain: `@${TEST_STUDENT_DOMAIN}` } });
        if (readded.status === 201) addedTestDomain = true;
        report(readded.status === 201 && readded.body.domain.domain === TEST_STUDENT_DOMAIN, 'Add a domain ("@" removed, lowercased)', `${readded.status}`);

        // Searching students
        await expect('Search with 1 character', call('GET', 'admin/students?q=a', { token: S }), 400, 'INVALID_SEARCH');
        const byNeptun = await call('GET', `admin/students?q=${neptun.toLowerCase()}`, { token: S });
        report(byNeptun.status === 200 && byNeptun.body.students.some((st) => st.id === account?.id), 'Search finds the student by Neptun code', `${byNeptun.body?.students?.length}`);
        const wildcard = await call('GET', `admin/students?q=${encodeURIComponent('%_')}`, { token: S });
        report(wildcard.status === 200 && wildcard.body.students.every((st) => `${st.name}${st.email}${st.neptun_code}`.includes('%_')), 'Search treats % and _ literally', `${wildcard.body?.students?.length}`);
        report((await call('GET', `admin/students?q=${encodeURIComponent(d.reviewer.email)}`, { token: S })).body?.students?.length === 0, 'Search lists students only (not reviewers)');

        // Changing the programme
        if (d.programmeCodes.length < 2 || !account) {
            skip('Change a student\'s programme', 'needs two programmes and the registered test student');
        } else {
            const [fromCode, toCode] = d.programmeCodes;
            const fromId = account.programme_id;
            const current = (await pool.query(`SELECT ${SEMESTER_NOW} AS id`)).rows[0].id;
            let seq = 0;
            const app = async (status) => {
                seq += 1;
                const code = `SECM${stamp}${seq}`.toUpperCase();
                const decided = status === 'approved';
                return (await pool.query(
                    `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id,
                         final_grade, decided_by_role, decided_at, info_requested_at, info_deadline)
                     VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN $7 THEN 4 END, CASE WHEN $7 THEN 'reviewer' END, CASE WHEN $7 THEN now() END,
                             CASE WHEN $5::varchar = 'needs_info' THEN now() END, CASE WHEN $5::varchar = 'needs_info' THEN now() + interval '2 days' END)
                     RETURNING id`,
                    [account.id, fromId, JSON.stringify([{ course_code: code, course_name: 'Programme check', credits: 3 }]), code, status, current, decided]
                )).rows[0].id;
            };
            const pending = await app('pending');
            const waiting = await app('needs_info');
            const approved = await app('approved');
            await pool.query("INSERT INTO application_drafts (student_id, version, data) VALUES ($1, 1, '{}') ON CONFLICT (student_id) DO NOTHING", [account.id]);

            const change = (json, id = account.id) => call('PUT', `admin/students/${id}/programme`, { token: S, json });
            await expect('Change to the same programme', change({ programme_code: fromCode }), 400, 'SAME_PROGRAMME');
            await expect('Change to an unknown programme', change({ programme_code: 'NOPE' }), 400, 'INVALID_PROGRAMME');
            await expect('Change without a programme', change({}), 400, 'INVALID_PROGRAMME');
            await expect("Change a reviewer's programme", change({ programme_code: toCode }, d.reviewer.id), 404, 'STUDENT_NOT_FOUND');
            await expect('Change with id "abc"', call('PUT', 'admin/students/abc/programme', { token: S, json: { programme_code: toCode } }), 400, 'INVALID_ID');

            const changed = await change({ programme_code: toCode });
            report(changed.status === 200 && changed.body.withdrawn === 2 && changed.body.draftRemoved === true,
                'Change the programme: 2 open applications withdrawn, draft removed', `${changed.status} ${changed.body?.withdrawn} ${changed.body?.draftRemoved}`);
            const rows = (await pool.query('SELECT id, status, info_deadline, final_grade FROM applications WHERE id = ANY($1)', [[pending, waiting, approved]])).rows;
            const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
            report(byId[pending].status === 'withdrawn' && byId[waiting].status === 'withdrawn' && byId[waiting].info_deadline === null,
                'Pending and needs-info are withdrawn (no reply deadline left for the deadline job)');
            report(byId[approved].status === 'approved' && byId[approved].final_grade === 4, 'The approved application stays as it is');
            const events = (await pool.query(
                "SELECT application_id, actor_role, actor_id, reason_code, created_at FROM application_events WHERE application_id = ANY($1) AND kind = 'withdrawn'", [[pending, waiting]]
            )).rows;
            report(events.length === 2 && events.every((e) => e.actor_role === 'admin' && e.actor_id === d.admin.id && e.reason_code === 'PROGRAMME_CHANGED' && e.created_at),
                'Each withdrawal is recorded as admin, with the admin\'s id, date and reason PROGRAMME_CHANGED');
            report((await pool.query('SELECT count(*)::int AS n FROM application_drafts WHERE student_id = $1', [account.id])).rows[0].n === 0, 'The unsent draft is deleted');
            const history = await call('GET', `admin/students/${account.id}/programme-changes`, { token: S });
            const last = history.body?.changes?.[0];
            report(history.status === 200 && last?.old_programme?.code === fromCode && last?.new_programme?.code === toCode && last.withdrawn_count === 2 && last.draft_removed && last.changed_by_name,
                'The change is recorded: who, old and new programme, date', `${last?.old_programme?.code} -> ${last?.new_programme?.code}`);
            report(await pool.query('UPDATE student_programme_changes SET withdrawn_count = 0 WHERE student_id = $1', [account.id]).then(() => false, () => true),
                'The change record cannot be edited');
            const T = tokenFor({ id: account.id, role: 'student' });
            const me = await call('GET', 'me', { token: T });
            report(me.status === 200 && me.body.user.programme?.code === toCode, "The student's profile shows the new programme", `${me.body?.user?.programme?.code}`);
            const mine = await call('GET', 'applications/mine', { token: T });
            const shown = (mine.body?.applications || []).find((a) => a.id === pending);
            report(shown?.status === 'withdrawn' && shown?.decision_reason === 'PROGRAMME_CHANGED' && shown?.decided_by === 'admin',
                'My Status shows the withdrawn application with its reason', `${shown?.status} ${shown?.decision_reason}`);
        }

        const removed = await removeTestStudents();
        console.log(`(removed ${removed} temporary student(s) with their applications and programme changes)`);
    }

    section('4n. Semesters and catalogue (admin round Group 4): semesters, Neptun import preview and confirm, Keep / Hide / Delete, hidden items');
    {
        const stamp = Date.now().toString(36).toUpperCase().slice(-5);
        const code = `SC${stamp}`.slice(0, 20);
        const routes = [['GET', 'admin/semesters'], ['POST', 'admin/semesters'], ['PUT', 'admin/semesters/1'], ['POST', 'admin/semesters/1/activate'],
            ['GET', 'admin/semesters/1/warnings'], ['GET', 'admin/catalogue?semester_id=1'], ['PUT', 'admin/programmes/1/status'],
            ['DELETE', 'admin/programmes/1'], ['PUT', 'admin/courses/1/status'], ['DELETE', 'admin/courses/1']];
        for (const [method, path] of routes) {
            await expect(`No token: ${method} /api/${path}`, call(method, path), 401, 'NO_TOKEN');
            await expect(`Student: ${method} /api/${path}`, call(method, path, { token: A, json: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN_ROLE');
            await expect(`Reviewer: ${method} /api/${path}`, call(method, path, { token: R, json: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN_ROLE');
        }
        await expect('No token: import preview', callForm('admin/catalogue/preview', {}), 401, 'NO_TOKEN');
        await expect('Reviewer: import preview', callForm('admin/catalogue/preview', { token: R, file: 'x' }), 403, 'FORBIDDEN_ROLE');

        // Semesters: input checks, a setup semester far ahead, several in progress (round 2 Group 1)
        const semester = (json) => call('POST', 'admin/semesters', { token: S, json });
        const good = { name: `Security check ${stamp}`, opens_at: '2097-02-01T08:00', closes_at: '2097-02-28T23:59', end_date: '2097-06-30' };
        await expect('Semester without a name', semester({ ...good, name: ' ' }), 400, 'INVALID_SEMESTER_NAME');
        await expect('Semester with a broken time', semester({ ...good, opens_at: '2097-02-30T08:00' }), 400, 'INVALID_TIME');
        await expect('Semester closing before it opens', semester({ ...good, closes_at: '2097-01-01T08:00' }), 400, 'CLOSE_BEFORE_OPEN');
        await expect('Review deadline before applications close', semester({ ...good, review_end_at: '2097-02-20T10:00' }), 400, 'REVIEW_BEFORE_CLOSE');
        const created = await semester(good);
        const semesterId = created.body?.semester?.id;
        if (semesterId) catalogueBackup.semesterIds.push(semesterId);
        const opensBp = created.body?.semester?.opens_at;
        report(created.status === 201 && created.body.semester.status === 'setup' && opensBp === new Date('2097-02-01T07:00:00Z').toISOString(),
            'New semester: in setup, times stored in UTC from Budapest time (08:00 Budapest = 07:00 UTC in winter)', `${created.status} ${opensBp}`);
        report(created.body?.semester?.review_end_at === new Date('2097-03-14T22:59:00Z').toISOString(),
            'Without a review deadline: applications close + 14 days (23:59 Budapest)', `${created.body?.semester?.review_end_at}`);
        await expect('A second semester with the same name', semester({ ...good, opens_at: '2096-02-01T08:00', closes_at: '2096-02-28T23:59', end_date: '2096-06-30' }), 409, 'SEMESTER_NAME_TAKEN');
        await expect('A semester whose application period overlaps it', semester({ ...good, name: `Overlap ${stamp}`, opens_at: '2097-02-20T08:00', closes_at: '2097-03-10T23:59' }), 409, 'SEMESTERS_OVERLAP');
        // The next period may open while this one is still being reviewed: only the application periods must not overlap
        const next = await semester({ ...good, name: `Next ${stamp}`, opens_at: '2097-03-01T00:00', closes_at: '2097-03-10T23:59' });
        if (next.body?.semester?.id) catalogueBackup.semesterIds.push(next.body.semester.id);
        report(next.status === 201, 'A next semester whose period starts during this one\'s review time (same semester dates): allowed', `${next.status} ${next.code || ''}`);
        // Several semesters in progress at once (round 2 Group 1); put back in setup right after
        const activated = await call('POST', `admin/semesters/${semesterId}/activate`, { token: S });
        const inProgress = (await pool.query("SELECT count(*)::int AS n FROM semesters WHERE status = 'active'")).rows[0].n;
        report(activated.status === 200 && inProgress >= 1, 'Activate while another semester is in progress: allowed', `${activated.status} ${activated.code || ''}, ${inProgress} in progress`);
        await pool.query("UPDATE semesters SET status = 'setup' WHERE id = $1", [semesterId]);
        const warnings = await call('GET', `admin/semesters/${semesterId}/warnings`, { token: S });
        report(warnings.status === 200 && warnings.body.warnings.every((w) => w.no_courses), 'Warnings: the new semester has no courses yet for each programme', `${warnings.body?.warnings?.length}`);

        // Import: preview saves nothing; a bad row is reported by number and doesn't block the others
        const header = 'programme_code;programme_name_hu;programme_name_en;programme_name_de;course_code;course_name;credits';
        const row = (c, name, credits, hu = 'Biztonsági teszt') => `${code};${hu};Security check;Sicherheitstest;${c};${name};${credits}`;
        const file1 = `﻿${[header, row('SC1', 'First', 5), row('SC2', 'Second', 'x'), row('SC3', 'Third', 4), row('SC4', 'Fourth', 3, 'Más név'), row('SC5', 'Fifth', 6)].join('\r\n')}\r\n`;
        const programmesBefore = (await pool.query('SELECT count(*)::int AS n FROM programmes')).rows[0].n;
        const preview1 = await callForm('admin/catalogue/preview', { token: S, fields: { semester_id: semesterId }, file: file1 });
        const p1 = preview1.body?.preview || {};
        report(preview1.status === 200 && p1.newProgrammes?.some((p) => p.code === code) && p1.newCourses?.length === 3
            && p1.errors?.some((e) => e.row === 3 && e.code === 'CREDITS_NOT_A_NUMBER') && p1.errors?.some((e) => e.row === 5 && e.code === 'PROGRAMME_NAME_CONFLICT'),
        'Preview: new programme, 3 valid courses, bad rows 3 and 5 reported by number', `${preview1.status} ${p1.newCourses?.length} ${JSON.stringify(p1.errors)}`);
        report(p1.missingProgrammes?.length > 0 && p1.missingProgrammes.every((p) => p.default === 'keep'), 'Programmes not in the file default to Keep');
        report((await pool.query('SELECT count(*)::int AS n FROM programmes')).rows[0].n === programmesBefore, 'The preview saved nothing');
        await expect('Preview without a file', callForm('admin/catalogue/preview', { token: S, fields: { semester_id: semesterId } }), 400, 'NO_FILE');
        await expect('Preview of a file that is not UTF-8', callForm('admin/catalogue/preview', { token: S, fields: { semester_id: semesterId }, file: Buffer.from([0x41, 0xff, 0x3b]) }), 400, 'NOT_UTF8');
        await expect('Preview of a file without the columns', callForm('admin/catalogue/preview', { token: S, fields: { semester_id: semesterId }, file: 'a;b\n1;2' }), 400, 'MISSING_COLUMNS');
        await expect('Confirm with another file than the preview', callForm('admin/catalogue/import', { token: S, fields: { semester_id: semesterId, hash: 'x'.repeat(64) }, file: file1 }), 409, 'PREVIEW_MISMATCH');
        const confirmed1 = await callForm('admin/catalogue/import', { token: S, fields: { semester_id: semesterId, hash: p1.hash, decisions: '{}' }, file: file1 });
        catalogueBackup.programmeCodes.push(code);
        report(confirmed1.status === 200 && confirmed1.body.summary.programmesAdded === 1 && confirmed1.body.summary.coursesAdded === 3 && confirmed1.body.summary.rowsSkipped === 2,
            'Confirm: 1 programme and 3 courses saved, 2 rows skipped', `${confirmed1.status} ${JSON.stringify(confirmed1.body?.summary || confirmed1.body)}`);
        const realHidden = (await pool.query("SELECT count(*)::int AS n FROM programmes WHERE status = 'hidden' AND code <> $1", [code])).rows[0].n;
        report(realHidden === 0, 'Keep (the default) left every other programme as it was');

        // Second file: SC1 changed, SC3 and SC5 missing (default Hide); an application uses SC3
        const courseId = async (c) => (await pool.query('SELECT c.id FROM courses c JOIN programmes p ON p.id = c.programme_id WHERE p.code = $1 AND c.course_code = $2 AND c.semester_id = $3', [code, c, semesterId])).rows[0]?.id;
        const sc3 = await courseId('SC3');
        const sc5 = await courseId('SC5');
        const programmeId = (await pool.query('SELECT id FROM programmes WHERE code = $1', [code])).rows[0].id;
        const snapshot = [{ course_id: sc3, course_code: 'SC3', course_name: 'Third', credits: 4 }];
        const usingApp = (await pool.query(
            `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id)
             VALUES ($1, $2, '[]', $3, 'SC3', 'pending', $4) RETURNING id`,
            [d.studentA.id, programmeId, JSON.stringify(snapshot), semesterId]
        )).rows[0].id;
        const file2 = `${[header, row('SC1', 'First, renamed', 6)].join('\n')}\n`;
        const preview2 = await callForm('admin/catalogue/preview', { token: S, fields: { semester_id: semesterId }, file: file2 });
        const p2 = preview2.body?.preview || {};
        const missing3 = p2.missingCourses?.find((c) => c.id === sc3);
        const missing5 = p2.missingCourses?.find((c) => c.id === sc5);
        report(p2.changedCourses?.some((c) => c.course_code === 'SC1' && c.before.credits === 5 && c.after.credits === 6), 'Preview: the changed course, old and new values');
        report(missing3?.default === 'hide' && missing5?.default === 'hide', 'Courses missing from a programme in the file default to Hide');
        report(missing3?.canDelete === false && missing3.blockedBy.includes('HAS_APPLICATIONS') && missing5?.canDelete === true, 'Delete is refused (with the reason) only for the course in use');
        const refused = await callForm('admin/catalogue/import', { token: S, fields: { semester_id: semesterId, hash: p2.hash, decisions: JSON.stringify({ courses: { [sc3]: 'delete' } }) }, file: file2 });
        report(refused.status === 409 && refused.code === 'DELETE_IN_USE' && (await pool.query('SELECT credits FROM courses WHERE id = (SELECT id FROM courses WHERE course_code = $1 AND semester_id = $2)', ['SC1', semesterId])).rows[0].credits === 5,
            'Deleting a course in use is refused and nothing is saved', `${refused.status} ${refused.code}`);
        const confirmed2 = await callForm('admin/catalogue/import', { token: S, fields: { semester_id: semesterId, hash: p2.hash, decisions: JSON.stringify({ courses: { [sc5]: 'delete' } }) }, file: file2 });
        const after = Object.fromEntries((await pool.query('SELECT id, status, credits FROM courses WHERE id = ANY($1)', [[sc3, sc5]])).rows.map((r) => [r.id, r]));
        report(confirmed2.status === 200 && after[sc3]?.status === 'hidden' && !after[sc5], 'Confirm: the course in use is hidden (all data kept), the unused one deleted', `${confirmed2.status}`);
        const kept = (await pool.query('SELECT target_courses, status FROM applications WHERE id = $1', [usingApp])).rows[0];
        const keptCourse = kept.target_courses?.[0] || {};
        report(kept.target_courses?.length === 1 && Object.entries(snapshot[0]).every(([key, value]) => keptCourse[key] === value) && kept.status === 'pending',
            'The import never changed the submitted application', JSON.stringify(kept.target_courses));

        // Programmes & Courses page and its Delete rule
        const page = await call('GET', `admin/catalogue?semester_id=${semesterId}`, { token: S });
        const own = page.body?.programmes?.find((p) => p.code === code);
        report(page.status === 200 && own && own.applications === 1 && own.canDelete === false, 'The page counts the applications and refuses Delete for a programme in use');
        await expect('Delete a programme in use', call('DELETE', `admin/programmes/${programmeId}?semester_id=${semesterId}`, { token: S }), 409, 'DELETE_IN_USE');
        await expect('Delete a course in use', call('DELETE', `admin/courses/${sc3}`, { token: S }), 409, 'DELETE_IN_USE');
        await expect('Change a status to something unknown', call('PUT', `admin/courses/${sc3}/status`, { token: S, json: { status: 'gone' } }), 400, 'INVALID_STATUS');

        // Student side: hidden courses and programmes are never offered
        const current = (await pool.query("SELECT id FROM semesters WHERE status = 'active'")).rows[0];
        const courseOfA = current && (await pool.query("SELECT id FROM courses WHERE programme_id = $1 AND semester_id = $2 AND status = 'active' LIMIT 1", [d.studentA.programme_id, current.id])).rows[0];
        if (!courseOfA) {
            skip('Hidden course and programme for students', 'no active semester course for student A');
        } else {
            catalogueBackup.hiddenCourses.push(courseOfA.id);
            await expect('Hide a course', call('PUT', `admin/courses/${courseOfA.id}/status`, { token: S, json: { status: 'hidden' } }), 200);
            const list = await call('GET', 'pte-courses', { token: A });
            report(list.status === 200 && !list.body.courses.some((c) => c.id === courseOfA.id), 'A hidden course is not offered to the student');
            await expect('Show it again', call('PUT', `admin/courses/${courseOfA.id}/status`, { token: S, json: { status: 'active' } }), 200);
            catalogueBackup.hiddenCourses.splice(0);

            const codeOfA = (await pool.query('SELECT code FROM programmes WHERE id = $1', [d.studentA.programme_id])).rows[0].code;
            catalogueBackup.hiddenProgrammes.push(d.studentA.programme_id);
            await expect('Hide student A\'s programme', call('PUT', `admin/programmes/${d.studentA.programme_id}/status`, { token: S, json: { status: 'hidden' } }), 200);
            const publicList = await call('GET', 'programmes');
            report(!publicList.body.programmes.some((p) => p.code === codeOfA), 'A hidden programme is not offered at registration');
            await expect('Register with a hidden programme', call('POST', 'register', { json: { name: 'Hidden', email: `hidden-${stamp}${TEST_DOMAIN}`, password: 'LongEnough1', neptun_code: 'ZZZ997', programme_code: codeOfA } }), 400, 'INVALID_PROGRAMME');
            const status = await call('GET', 'settings/status', { token: A });
            report(status.body?.submission?.state === 'programme_hidden' && status.body.submission.canSubmit === false, 'Its students see that no new application is possible');
            const blocked = await call('POST', 'applications', { token: A, json: { target_course_ids: [courseOfA.id] } });
            report(blocked.status === 403 && ['PROGRAMME_HIDDEN', 'SUBMISSIONS_CLOSED', 'NO_APPLICATION_PERIOD', 'APPLICATION_PERIOD_NOT_STARTED'].includes(blocked.code),
                'Its students cannot submit (refused by the server)', `${blocked.status} ${blocked.code}`);
            const mine = await call('GET', 'applications/mine', { token: A });
            report(mine.status === 200, 'They still see their existing applications');
            await expect('Show the programme again', call('PUT', `admin/programmes/${d.studentA.programme_id}/status`, { token: S, json: { status: 'active' } }), 200);
            catalogueBackup.hiddenProgrammes.splice(0);
        }

        await restoreCatalogue();
        report((await pool.query('SELECT count(*)::int AS n FROM programmes WHERE code = $1', [code])).rows[0].n === 0, '(the temporary programme and semester were removed)');
    }

    section('4o. Application period (admin round Group 5): Close now, Reopen until, late access, the closed period, the admin summary');
    {
        const stamp = Date.now().toString(36);
        const routes = [['POST', 'admin/semesters/1/close-now'], ['POST', 'admin/semesters/1/reopen'], ['GET', 'admin/late-access'],
            ['POST', 'admin/late-access'], ['DELETE', 'admin/late-access/1'], ['GET', 'admin/summary']];
        for (const [method, path] of routes) {
            await expect(`No token: ${method} /api/${path}`, call(method, path), 401, 'NO_TOKEN');
            await expect(`Student: ${method} /api/${path}`, call(method, path, { token: A, json: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN_ROLE');
            await expect(`Reviewer: ${method} /api/${path}`, call(method, path, { token: R, json: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN_ROLE');
        }
        const publicPeriod = await call('GET', 'settings/period');
        report(publicPeriod.status === 200 && publicPeriod.body.period && !('lateAccess' in publicPeriod.body.period) && !JSON.stringify(publicPeriod.body).includes('"id"'),
            'The public period (registration page): no ids, no late access', `${publicPeriod.status}`);

        const active = (await pool.query("SELECT id FROM semesters WHERE status = 'active'")).rows[0];
        if (!active) {
            skip('All application period controls', 'no active semester in this database');
        } else {
            const sid = active.id;
            semesterBackup = (await pool.query('SELECT id, applications_open_at, applications_close_at, review_end_at, end_date, close_reason, last_days_warning_days FROM semesters WHERE id = $1', [sid])).rows[0];
            const day = (offset) => pool.query(`SELECT to_char((now() AT TIME ZONE 'Europe/Budapest')::date + $1::int, 'YYYY-MM-DD') AS d`, [offset]).then((r) => r.rows[0].d);
            const endDay = await day(40);
            await pool.query(
                `UPDATE semesters SET applications_open_at = ((now() AT TIME ZONE 'Europe/Budapest')::date - 10)::timestamp AT TIME ZONE 'Europe/Budapest',
                     applications_close_at = (((now() AT TIME ZONE 'Europe/Budapest')::date + 20)::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
                     review_end_at = (((now() AT TIME ZONE 'Europe/Budapest')::date + 34)::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
                     end_date = $2::date, close_reason = NULL WHERE id = $1`,
                [sid, endDay]
            );
            const stateOf = async (token) => (await call('GET', 'settings/status', { token })).body?.submission;

            // Close now
            await expect('Close now with a 301-character reason', call('POST', `admin/semesters/${sid}/close-now`, { token: S, json: { reason: 'x'.repeat(301) } }), 400, 'REASON_TOO_LONG');
            await expect('Close now', call('POST', `admin/semesters/${sid}/close-now`, { token: S, json: { reason: 'Technical maintenance' } }), 200);
            const closed = await stateOf(A);
            report(closed?.state === 'closed_by_admin' && closed.canSubmit === false && closed.semester.closeReason === 'Technical maintenance',
                'Closed at once, with the reason shown to students', `${closed?.state}`);
            await expect('Submitting while closed (direct API call)', call('POST', 'applications', { token: A, json: {} }), 403, 'SUBMISSIONS_CLOSED');
            await expect('Saving a draft while closed', call('PUT', 'drafts/mine', { token: A, json: { version: 1, data: {} } }), 403, 'SUBMISSIONS_CLOSED');
            await expect('Registering while closed (direct API call)', call('POST', 'register', { json: { name: 'Closed', email: `closed-${stamp}${TEST_DOMAIN}`, password: 'LongEnough1', neptun_code: 'ZZZ996', programme_code: d.programmeCodes[0] } }), 403, 'APPLICATIONS_CLOSED');
            report((await call('GET', 'settings/period')).body?.period?.state === 'closed_by_admin', 'The registration page knows it is closed');
            await expect('Close now while already closed', call('POST', `admin/semesters/${sid}/close-now`, { token: S, json: {} }), 409, 'PERIOD_NOT_OPEN');
            report((await stateOf(R)) !== undefined, 'Reviewers keep working (their status still answers)');

            // A closed-period student: the needs-info application can still be answered, a pending one withdrawn
            let seq = 0;
            const tempOfA = async (status) => {
                seq += 1;
                const c = `SECO${stamp}${seq}`.toUpperCase();
                const id = (await pool.query(
                    `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, info_requested_at, info_deadline)
                     VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN $5::varchar = 'needs_info' THEN now() END, CASE WHEN $5::varchar = 'needs_info' THEN now() + interval '2 days' END) RETURNING id`,
                    [d.studentA.id, d.studentA.programme_id, JSON.stringify([{ course_code: c, course_name: 'Period check', credits: 1 }]), c, status, sid]
                )).rows[0].id;
                tempApplicationIds.push(id);
                return id;
            };
            const waiting = await tempOfA('needs_info');
            await expect('While closed: reply to the needs-info application', call('PUT', `applications/${waiting}/resubmit`, { token: A, json: { student_resubmit_note: 'Here is the syllabus.' } }), 200);
            const pendingOfA = await tempOfA('pending');
            await expect('While closed: withdraw a pending application', call('PUT', `applications/${pendingOfA}/withdraw`, { token: A }), 200);
            const withdrawnBy = (await pool.query("SELECT actor_role, actor_id FROM application_events WHERE application_id = $1 AND kind = 'withdrawn'", [pendingOfA])).rows[0];
            report(withdrawnBy?.actor_role === 'student' && withdrawnBy.actor_id === d.studentA.id, 'Recorded as the student\'s own withdrawal');

            // Reopen until
            await expect('Reopen with a broken time', call('POST', `admin/semesters/${sid}/reopen`, { token: S, json: { until: 'tomorrow' } }), 400, 'INVALID_TIME');
            await expect('Reopen until a time in the past', call('POST', `admin/semesters/${sid}/reopen`, { token: S, json: { until: `${await day(-1)}T10:00` } }), 400, 'TIME_NOT_IN_FUTURE');
            await expect('Reopen until after the review deadline', call('POST', `admin/semesters/${sid}/reopen`, { token: S, json: { until: `${await day(45)}T10:00` } }), 400, 'AFTER_REVIEW_DEADLINE');
            await expect('Reopen until a future time', call('POST', `admin/semesters/${sid}/reopen`, { token: S, json: { until: `${await day(5)}T23:59` } }), 200);
            const reopened = await stateOf(A);
            report(['open', 'last_days'].includes(reopened?.state) && reopened.canSubmit && !reopened.semester.closeReason, 'Open again for everyone, the reason cleared', `${reopened?.state}`);
            const closesNow = (await pool.query("SELECT to_char(applications_close_at AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD HH24:MI') AS c FROM semesters WHERE id = $1", [sid])).rows[0].c;
            report(closesNow === `${await day(5)} 23:59`, 'The closing time is the new one (Budapest time)', closesNow);
            // Up to the review deadline (round 2 Group 1); fewer than 7 days left for reviewing: "tight"
            const tight = await call('POST', `admin/semesters/${sid}/reopen`, { token: S, json: { until: `${await day(30)}T23:59` } });
            report(tight.status === 200 && tight.body.tight === true, 'Reopen until 4 days before the review deadline: allowed, marked tight (the screen offers to move it)', `${tight.status} ${tight.body?.tight}`);
            const moved = await call('POST', `admin/semesters/${sid}/reopen`, { token: S, json: { until: `${await day(45)}T23:59`, review_end_at: `${await day(60)}T23:59` } });
            const reviewNow = (await pool.query("SELECT to_char(review_end_at AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD HH24:MI') AS r FROM semesters WHERE id = $1", [sid])).rows[0].r;
            report(moved.status === 200 && moved.body.tight === false && reviewNow === `${await day(60)} 23:59`, 'Reopen until later, moving the review deadline in the same step', `${moved.status} ${reviewNow}`);
            await expect('Reopen with a review deadline before the new close', call('POST', `admin/semesters/${sid}/reopen`, { token: S, json: { until: `${await day(45)}T23:59`, review_end_at: `${await day(44)}T23:59` } }), 400, 'AFTER_REVIEW_DEADLINE');
            await expect('Reopen until a future time (back to 5 days)', call('POST', `admin/semesters/${sid}/reopen`, { token: S, json: { until: `${await day(5)}T23:59` } }), 200);
            await expect('Last-days warning of 61 days', call('PUT', `admin/semesters/${sid}`, { token: S, json: { name: 'x', opens_at: '2026-01-01T00:00', closes_at: '2026-01-02T00:00', end_date: '2026-02-01', last_days: 61 } }), 400, 'INVALID_LAST_DAYS');

            // Late access while closed
            await call('POST', `admin/semesters/${sid}/close-now`, { token: S, json: {} });
            const lateEmail = `late-${stamp}${TEST_DOMAIN}`;
            const deadline = `${await day(2)}T23:59`;
            await expect('Late access without addresses', call('POST', 'admin/late-access', { token: S, json: { emails: ' ', deadline } }), 400, 'NO_EMAILS');
            await expect('Late access with a past deadline', call('POST', 'admin/late-access', { token: S, json: { emails: lateEmail, deadline: `${await day(-1)}T10:00` } }), 400, 'TIME_NOT_IN_FUTURE');
            await expect('Late access after the review deadline', call('POST', 'admin/late-access', { token: S, json: { emails: lateEmail, deadline: `${await day(70)}T10:00`, semester_id: sid } }), 400, 'AFTER_REVIEW_DEADLINE');
            await expect('Late access for a semester not in progress', call('POST', 'admin/late-access', { token: S, json: { emails: lateEmail, deadline, semester_id: 999999 } }), 404, 'SEMESTER_NOT_FOUND');
            const granted = await call('POST', 'admin/late-access', { token: S, json: { emails: `${lateEmail.toUpperCase()}, not-an-email, x-${stamp}@unlisted.invalid, ${d.reviewer.email}`, deadline, language: 'en' } });
            const result = Object.fromEntries((granted.body?.results || []).map((r) => [r.email, r]));
            report(granted.status === 201 && result[lateEmail]?.ok === true && result['not-an-email']?.code === 'INVALID_EMAIL'
                && result[`x-${stamp}@unlisted.invalid`]?.code === 'EMAIL_DOMAIN_NOT_ALLOWED' && result[d.reviewer.email]?.code === 'NOT_A_STUDENT_EMAIL',
            'Late access: granted (lowercased); bad address, unlisted domain and staff address each refused on their own', JSON.stringify(granted.body?.results));
            const registered = await call('POST', 'register', { json: { name: 'Late Student', email: lateEmail.toUpperCase(), password: 'LongEnough1', neptun_code: `L${stamp.slice(-5).toUpperCase()}`.slice(0, 6).replace(/[^A-Z0-9]/g, 'X').padEnd(6, 'X'), programme_code: d.programmeCodes[0] } });
            report(registered.status === 200, 'With late access, registering while closed works (address matched without case)', `${registered.status} ${registered.code || ''}`);
            const lateStudent = (await pool.query('SELECT id FROM users WHERE email = $1', [lateEmail])).rows[0];
            if (lateStudent) {
                await pool.query('UPDATE users SET is_verified = true WHERE id = $1', [lateStudent.id]);
                const L = tokenFor({ id: lateStudent.id, role: 'student' });
                const lateState = await stateOf(L);
                report(lateState?.canSubmit === true && !!lateState.lateAccess?.deadline && lateState.state === 'closed_by_admin', 'They can submit until their deadline, which is shown');
                await expect('Submitting with late access passes the period check', call('POST', 'applications', { token: L, json: {} }), 400);
                report((await stateOf(A))?.canSubmit === false, 'Other students still cannot');
                const list = await call('GET', 'admin/late-access', { token: S });
                const grant = (list.body?.grants || []).find((g) => g.email === lateEmail);
                report(grant?.status === 'active' && grant.registered === true && grant.granted_by_name, 'The admin sees the grant: active, registered, who granted it');
                await expect('Revoke the late access', call('DELETE', `admin/late-access/${grant?.id}`, { token: S }), 200);
                report((await stateOf(L))?.canSubmit === false, 'Revoking takes effect at once');
                await expect('Submitting after it was revoked', call('POST', 'applications', { token: L, json: {} }), 403, 'SUBMISSIONS_CLOSED');
                const again = await call('DELETE', `admin/late-access/${grant?.id}`, { token: S });
                report(again.status === 200 && again.body.alreadyRevoked === true, 'Revoking again changes nothing');
            }
            await expect('Revoke a grant that does not exist', call('DELETE', 'admin/late-access/999999999', { token: S }), 404, 'LATE_ACCESS_NOT_FOUND');

            // The admin menu's summary matches the database
            const summary = (await call('GET', 'admin/summary', { token: S })).body?.summary;
            const truth = (await pool.query(
                `SELECT (SELECT count(*)::int FROM applications WHERE semester_id = $1 AND status = 'pending') AS pending,
                        (SELECT count(*)::int FROM allowed_domains) AS domains`, [sid]
            )).rows[0];
            report(summary?.pending === truth.pending && summary?.domains === truth.domains && summary?.activeSemester?.id === sid,
                'The admin summary (menu badges) matches the database', `${summary?.pending}/${truth.pending}`);

            const removedApps = await removeTempApplications();
            const restored = await restoreSemesters();
            const removedStudents = await removeTestStudents();
            console.log(`(removed ${removedApps} temporary application(s) and ${removedStudents} student(s) with their late access; ${restored})`);
        }
    }

    section('4p. Closing the semester (admin round Group 6; round 2: only when everything is decided, nobody rejected): preview = result, PDF book, read-only for everyone, Past semesters');
    {
        const stamp = Date.now().toString(36);
        const routes = [['GET', 'admin/semesters/1/close-preview'], ['POST', 'admin/semesters/1/close'], ['GET', 'admin/past-semesters'],
            ['GET', 'admin/past-semesters/1/applications'], ['GET', 'admin/past-semesters/1/applications/1'], ['GET', 'admin/past-semesters/1/export.csv'],
            ['GET', 'admin/past-semesters/1/book'], ['POST', 'admin/past-semesters/1/book']];
        for (const [method, path] of routes) {
            await expect(`No token: ${method} /api/${path}`, call(method, path), 401, 'NO_TOKEN');
            await expect(`Student: ${method} /api/${path}`, call(method, path, { token: A, json: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN_ROLE');
            await expect(`Reviewer: ${method} /api/${path}`, call(method, path, { token: R, json: method === 'GET' ? undefined : {} }), 403, 'FORBIDDEN_ROLE');
        }

        const realActive = (await pool.query("SELECT id, name FROM semesters WHERE status = 'active'")).rows[0];
        if (!realActive) {
            skip('Closing a semester', 'no active semester in this database');
        } else {
            closeBackup.drafts = (await pool.query('SELECT * FROM application_drafts')).rows;
            const tempName = `Security check close ${stamp}`;
            const tempId = (await pool.query(INSERT_SEMESTER_SQL, [tempName, '2001-02-01', '2001-03-01', '2001-06-30', 'setup'])).rows[0].id;
            closeBackup.tempSemesterId = tempId;
            closeBackup.realActiveId = realActive.id;
            await pool.query("UPDATE semesters SET status = 'setup' WHERE id = $1", [realActive.id]);
            await pool.query("UPDATE semesters SET status = 'active' WHERE id = $1", [tempId]);

            // A temporary student of the reviewer's programme (the emails go to @security-check.invalid)
            const neptun = `C${stamp.slice(-5).toUpperCase()}`.replace(/[^A-Z0-9]/g, 'X').padEnd(6, 'X').slice(0, 6);
            const student = (await pool.query(
                `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
                 VALUES ('Security Check Close', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id, role`,
                [`close-${stamp}${TEST_DOMAIN}`, neptun, d.reviewer.programme_id]
            )).rows[0];
            let seq = 0;
            const app = async (status) => {
                seq += 1;
                const c = `SECP${stamp}${seq}`.toUpperCase();
                return (await pool.query(
                    `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id,
                         final_grade, decided_by_role, decided_at, info_requested_at, info_deadline)
                     VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN $5::varchar = 'approved' THEN 4 END, CASE WHEN $5::varchar = 'approved' THEN 'reviewer' END,
                             CASE WHEN $5::varchar = 'approved' THEN now() END, CASE WHEN $5::varchar = 'needs_info' THEN now() END,
                             CASE WHEN $5::varchar = 'needs_info' THEN now() + interval '2 days' END) RETURNING id`,
                    [student.id, d.reviewer.programme_id, JSON.stringify([{ course_code: c, course_name: 'Close check', credits: 3 }]), c, status, tempId]
                )).rows[0].id;
            };
            const pendingId = await app('pending');
            await app('pending');
            const waitingId = await app('needs_info');
            const approvedId = await app('approved');
            await pool.query("INSERT INTO late_access (email, semester_id, deadline) VALUES ($1, $2, now() + interval '1 day')", [`late-close-${stamp}${TEST_DOMAIN}`, tempId]);

            // Round 2 Group 1: closing needs the period over, no late access running and nothing undecided
            const tempOf = (summary) => (summary?.semesters || []).find((x) => x.id === tempId);
            report(tempOf((await call('GET', 'admin/summary', { token: S })).body?.summary)?.canClose === false,
                'Not ready to close while applications are undecided and late access runs (summary)');
            const appsList = await call('GET', 'applications', { token: S });
            report((appsList.body?.applications || []).every((a) => a.semester_id === tempId), 'The admin\'s Applications list shows the semesters in progress only');

            const preview = (await call('GET', `admin/semesters/${tempId}/close-preview`, { token: S })).body?.preview;
            const draftsBefore = (await pool.query('SELECT count(*)::int AS n FROM application_drafts')).rows[0].n;
            const programmeRow = (preview?.undecidedByProgramme || []).find((p) => p.pending === 2 && p.needs_info === 1);
            report(preview?.canClose === false && JSON.stringify(preview.blockers) === JSON.stringify(['LATE_ACCESS_ACTIVE', 'UNDECIDED_APPLICATIONS'])
                && !!programmeRow && preview.drafts + preview.draftsKept === draftsBefore,
            'Close preview: blocked by the late access and the undecided applications, listed per programme', JSON.stringify(preview));
            await expect('Close with a wrong name', call('POST', `admin/semesters/${tempId}/close`, { token: S, json: { confirm_name: 'Wrong name' } }), 400, 'CONFIRM_NAME_MISMATCH');
            await expect('Close without a name', call('POST', `admin/semesters/${tempId}/close`, { token: S, json: {} }), 400, 'CONFIRM_NAME_MISMATCH');
            await expect('Close a semester that is not in progress', call('POST', `admin/semesters/${realActive.id}/close`, { token: S, json: { confirm_name: realActive.name } }), 409, 'SEMESTER_NOT_ACTIVE');
            await expect('Close while late access runs', call('POST', `admin/semesters/${tempId}/close`, { token: S, json: { confirm_name: tempName } }), 409, 'LATE_ACCESS_ACTIVE');
            await pool.query('UPDATE late_access SET revoked_at = now() WHERE semester_id = $1 AND revoked_at IS NULL', [tempId]);
            await expect('Close while applications are undecided', call('POST', `admin/semesters/${tempId}/close`, { token: S, json: { confirm_name: tempName } }), 409, 'UNDECIDED_APPLICATIONS');
            report((await pool.query("SELECT count(*)::int AS n FROM application_events e JOIN applications a ON a.id = e.application_id WHERE a.semester_id = $1 AND e.kind = 'auto_rejected'", [tempId])).rows[0].n === 0,
                'Refused closes reject nobody');

            // Everything decided (the reviewer decides two, the student withdraws the one waiting for them)
            const secondPending = (await pool.query("SELECT id FROM applications WHERE semester_id = $1 AND status = 'pending' AND id <> $2", [tempId, pendingId])).rows[0].id;
            const T0 = tokenFor(student);
            await expect('The reviewer approves one', call('PUT', `applications/${pendingId}/status`, { token: R, json: { status: 'approved', final_grade: 4, note: 'Close check' } }), 200);
            await expect('The reviewer rejects one', call('PUT', `applications/${secondPending}/status`, { token: R, json: { status: 'rejected', note: 'Close check' } }), 200);
            await expect('The student withdraws the needs-info one', call('PUT', `applications/${waitingId}/withdraw`, { token: T0 }), 200);
            report((await call('GET', 'admin/summary', { token: S })).body?.summary?.readyToClose === true && tempOf((await call('GET', 'admin/summary', { token: S })).body?.summary)?.canClose === true,
                'Now the admin summary says "Ready to close" (Semester badge)');
            const ready = (await call('GET', `admin/semesters/${tempId}/close-preview`, { token: S })).body?.preview;
            report(ready?.canClose === true && ready.blockers.length === 0, 'Close preview: nothing blocks it', JSON.stringify(ready?.blockers));

            const closed = await call('POST', `admin/semesters/${tempId}/close`, { token: S, json: { confirm_name: tempName } });
            const summary = closed.body?.summary || {};
            closeBackup.bookName = (await pool.query('SELECT book_name FROM semesters WHERE id = $1', [tempId])).rows[0].book_name;
            report(closed.status === 200 && summary.drafts === ready?.drafts && summary.rejected === undefined, 'The close did what the preview said, and rejected nobody', JSON.stringify(summary));
            report(!!summary.book?.name && !!closeBackup.bookName, 'The PDF book was created after the close', JSON.stringify(summary.book));
            const rows = Object.fromEntries((await pool.query('SELECT id, status, decided_by_role FROM applications WHERE semester_id = $1', [tempId])).rows.map((r) => [r.id, r]));
            report(rows[pendingId].status === 'approved' && rows[secondPending].status === 'rejected' && rows[secondPending].decided_by_role === 'reviewer'
                && rows[waitingId].status === 'withdrawn' && rows[approvedId].status === 'approved', 'Every decision kept as it was made; no System rejection');
            const semester = (await pool.query('SELECT status, closed_at, closed_by FROM semesters WHERE id = $1', [tempId])).rows[0];
            report(semester.status === 'closed' && semester.closed_at && semester.closed_by === d.admin.id, 'Closed, with the time and who closed it');
            report((await pool.query('SELECT count(*)::int AS n FROM late_access WHERE semester_id = $1 AND revoked_at IS NULL', [tempId])).rows[0].n === 0, 'Its late access ended');
            report((await pool.query('SELECT count(*)::int AS n FROM applications WHERE semester_id = $1', [tempId])).rows[0].n === 4, 'No application was deleted');
            await expect('Closing it again', call('POST', `admin/semesters/${tempId}/close`, { token: S, json: { confirm_name: tempName } }), 409, 'ALREADY_CLOSED');

            // Read-only for everyone, also through the API directly
            const stillPending = await app('pending');
            const stillWaiting = await app('needs_info');
            const T = tokenFor(student);
            const decide = (token, id) => call('PUT', `applications/${id}/status`, { token, json: { status: 'approved', final_grade: 4 } });
            await expect('Closed semester: the reviewer decides', decide(R, stillPending), 409, 'SEMESTER_ENDED');
            await expect('Closed semester: the admin decides (Decide / overrides)', decide(S, stillPending), 409, 'SEMESTER_ENDED');
            const actingR = await actingTokenFor(S, d.reviewer);
            await expect('Closed semester: the admin acting as the reviewer decides', decide(actingR, stillPending), 409, 'SEMESTER_ENDED');
            await call('POST', 'acting/exit', { token: actingR });
            await expect('Closed semester: the student withdraws', call('PUT', `applications/${stillPending}/withdraw`, { token: T }), 409, 'SEMESTER_ENDED');
            await expect('Closed semester: the student replies to a request for information', call('PUT', `applications/${stillWaiting}/resubmit`, { token: T, json: { student_resubmit_note: 'Late reply' } }), 409, 'SEMESTER_ENDED');
            const actingT = await actingTokenFor(S, student);
            await expect('Closed semester: the admin acting as the student withdraws', call('PUT', `applications/${stillPending}/withdraw`, { token: actingT }), 409, 'SEMESTER_ENDED');
            await call('POST', 'acting/exit', { token: actingT });
            await expect('Closed semester: edit its dates', call('PUT', `admin/semesters/${tempId}`, { token: S, json: { name: tempName, opens_at: '2001-02-01T00:00', closes_at: '2001-03-01T23:59', end_date: '2001-07-30' } }), 409, 'SEMESTER_CLOSED');
            await expect('Closed semester: Close now', call('POST', `admin/semesters/${tempId}/close-now`, { token: S, json: {} }), 409, 'SEMESTER_NOT_ACTIVE');
            await expect('Closed semester: Reopen', call('POST', `admin/semesters/${tempId}/reopen`, { token: S, json: { until: '2099-01-01T10:00' } }), 409, 'SEMESTER_NOT_ACTIVE');
            await expect('Closed semester: activate it again', call('POST', `admin/semesters/${tempId}/activate`, { token: S }), 409, 'SEMESTER_CLOSED');
            report((await pool.query('SELECT status FROM applications WHERE id = $1', [stillPending])).rows[0].status === 'pending', 'Nothing changed in the closed semester');

            // A setup semester can be activated after the close (this also puts the real one back)
            await expect('After the close: activate the semester waiting in setup', call('POST', `admin/semesters/${realActive.id}/activate`, { token: S }), 200);
            closeBackup.realActiveId = null;

            // Past semesters
            const past = await call('GET', 'admin/past-semesters', { token: S });
            const listed = (past.body?.semesters || []).find((x) => x.id === tempId);
            report(listed?.has_book === true && listed.applications === 6, 'Past semesters lists it, with its PDF book and every application', JSON.stringify(listed));
            const found = await call('GET', `admin/past-semesters/${tempId}/applications?q=${encodeURIComponent('Security Check Close')}`, { token: S });
            report(found.status === 200 && found.body.total === 6, 'Search by student name', `${found.body?.total}`);
            // (closing rejects nobody now: the two the reviewer approved earlier are the approved ones)
            const byNeptun = await call('GET', `admin/past-semesters/${tempId}/applications?q=${neptun.toLowerCase()}&status=approved`, { token: S });
            report(byNeptun.body?.total === 2, 'Search by Neptun code and status', `${byNeptun.body?.total}`);
            const byCourse = await call('GET', `admin/past-semesters/${tempId}/applications?q=SECP${stamp}1`, { token: S });
            report(byCourse.body?.total >= 1, 'Search by course code');
            await expect('Search with an unknown status', call('GET', `admin/past-semesters/${tempId}/applications?status=lost`, { token: S }), 400, 'INVALID_STATUS');
            await expect('Search a semester that is not closed', call('GET', `admin/past-semesters/${realActive.id}/applications`, { token: S }), 404, 'SEMESTER_NOT_FOUND');
            const detail = await call('GET', `admin/past-semesters/${tempId}/applications/${pendingId}`, { token: S });
            report(detail.status === 200 && detail.body.application.read_only === true && detail.body.application.status === 'approved', 'One application opens read-only');
            await expect('An application of another semester', call('GET', `admin/past-semesters/${tempId}/applications/${d.appOfB.id}`, { token: S }), 404, 'APPLICATION_NOT_FOUND');
            const csv = await fetch(`${API}/admin/past-semesters/${tempId}/export.csv?status=approved&lang=hu`, { headers: { Authorization: `Bearer ${S}` } });
            const csvBytes = Buffer.from(await csv.arrayBuffer()); // .text() would drop the BOM
            const csvText = csvBytes.toString('utf8');
            const csvLines = csvText.replace(/^\uFEFF/, '').trim().split('\r\n');
            report(csv.status === 200 && csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF && csvLines.length === 3 && csvLines[0].startsWith('"Kérelem";') && csvLines.slice(1).every((l) => l.includes('Elfogadva')),
                'CSV export: the search results (2 + header), UTF-8 with BOM, in the chosen language', `${csvLines.length} lines`);
            const book = await fetch(`${API}/admin/past-semesters/${tempId}/book`, { headers: { Authorization: `Bearer ${S}` } });
            report(book.status === 200 && (book.headers.get('content-type') || '').includes('application/pdf'), 'The PDF book downloads');
            const previousBook = closeBackup.bookName;
            const again = await call('POST', `admin/past-semesters/${tempId}/book`, { token: S });
            report(again.status === 200 && again.body.book && again.body.book !== previousBook, 'Generate the PDF again, without reopening anything');
            await minioClient.removeObject(ARCHIVE_BUCKET, previousBook).catch(() => {});
            closeBackup.bookName = again.body?.book || null;
            report((await pool.query('SELECT status FROM semesters WHERE id = $1', [tempId])).rows[0].status === 'closed', 'Still closed');

            await removeTestStudents();
            await restoreClose();
            console.log('(removed the temporary semester, its student, applications and PDF books; the real semester is active again; drafts put back)');
        }
    }

    section('4q. Analytics and reports (admin round Group 7): hand counts, time to decision without System, CSV, "review deadline" warnings');
    {
        const stamp = Date.now().toString(36);
        for (const path of ['admin/analytics', 'admin/analytics/export.csv?table=status']) {
            await expect(`No token: GET /api/${path}`, call('GET', path), 401, 'NO_TOKEN');
            await expect(`Student: GET /api/${path}`, call('GET', path, { token: A }), 403, 'FORBIDDEN_ROLE');
            await expect(`Reviewer: GET /api/${path}`, call('GET', path, { token: R }), 403, 'FORBIDDEN_ROLE');
        }
        await expect('Analytics with semester_id "abc"', call('GET', 'admin/analytics?semester_id=abc', { token: S }), 400, 'INVALID_ID');
        await expect('Analytics of a semester that does not exist', call('GET', 'admin/analytics?semester_id=999999999', { token: S }), 404, 'SEMESTER_NOT_FOUND');
        await expect('Export an unknown table', call('GET', 'admin/analytics/export.csv?table=secrets', { token: S }), 400, 'INVALID_TABLE');
        const setup = (await pool.query(INSERT_SEMESTER_SQL, [`Security check analytics setup ${stamp}`, '2095-02-01', '2095-03-01', '2095-06-30', 'setup'])).rows[0].id;
        tempSemesterIds.push(setup);
        await expect('Analytics of a semester in setup', call('GET', `admin/analytics?semester_id=${setup}`, { token: S }), 400, 'SEMESTER_IN_SETUP');

        // A closed semester with applications counted by hand
        const closedId = (await pool.query(INSERT_SEMESTER_SQL, [`Security check analytics ${stamp}`, '2002-02-01', '2002-03-01', '2002-06-30', 'closed'])).rows[0].id;
        tempSemesterIds.push(closedId);
        const T0 = new Date('2002-02-10T09:00:00Z');
        const dayAt = (n) => new Date(T0.getTime() + n * 24 * 3600 * 1000);
        let seq = 0;
        const closedApp = async ({ status, course, after = null, by = null }) => {
            seq += 1;
            const student = (await pool.query(
                `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
                 VALUES ('Security Check Analytics', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id`,
                [`analytics-${stamp}-${seq}${TEST_DOMAIN}`, `Q${stamp.slice(-4).toUpperCase()}${seq}`.replace(/[^A-Z0-9]/g, 'X').slice(0, 6).padEnd(6, '0'), d.studentA.programme_id]
            )).rows[0];
            const id = (await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, created_at,
                     final_grade, decided_by_role, decided_at)
                 VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, $7::timestamptz AT TIME ZONE 'UTC', CASE WHEN $5::varchar = 'approved' THEN 4 END, $8, $9) RETURNING id`,
                [student.id, d.studentA.programme_id, JSON.stringify([{ course_code: course.toUpperCase(), course_name: 'Analytics check', credits: 3 }]), course.toUpperCase(), status, closedId, T0,
                    after === null ? null : by, after === null ? null : dayAt(after)]
            )).rows[0].id;
            return id;
        };
        await closedApp({ status: 'approved', course: `SQA${stamp}`, after: 2, by: 'reviewer' });
        const waited = await closedApp({ status: 'approved', course: `SQA${stamp}`, after: 4, by: 'admin' });
        await pool.query("INSERT INTO application_events (application_id, kind, actor_role, status, created_at) VALUES ($1, 'info_requested', 'reviewer', 'needs_info', $2), ($1, 'replied', 'student', 'pending', $3)", [waited, dayAt(1), dayAt(3)]);
        await closedApp({ status: 'rejected', course: `SQB${stamp}`, after: 30, by: 'system' });
        await closedApp({ status: 'withdrawn', course: `SQB${stamp}` });
        const closed = (await call('GET', `admin/analytics?semester_id=${closedId}`, { token: S })).body?.analytics;
        report(closed && JSON.stringify(closed.status.overall) === JSON.stringify({ pending: 0, needs_info: 0, approved: 2, rejected: 1, withdrawn: 1, total: 4 }),
            'Closed semester: applications by status match the hand count', JSON.stringify(closed?.status?.overall));
        const t = closed?.turnaround?.overall;
        report(t && t.decided === 2 && t.averageDays === 3 && t.medianDays === 3 && t.averageDaysWithoutWaiting === 2 && t.medianDaysWithoutWaiting === 2,
            'Time to decision: 2 and 4 days (System left out); without waiting 2 and 2', JSON.stringify(t));
        report(JSON.stringify((closed?.topCourses || []).map((c) => [c.courseCode, c.applications])) === JSON.stringify([[`SQA${stamp}`.toUpperCase(), 2], [`SQB${stamp}`.toUpperCase(), 1]]),
            'Top courses: withdrawn left out, the System rejection counted', JSON.stringify(closed?.topCourses?.map((c) => [c.courseCode, c.applications])));

        // The active semester against an independent count
        const active = await call('GET', 'admin/analytics', { token: S });
        if (!active.body?.semester) {
            skip('Analytics of the active semester', 'no active semester in this database');
        } else {
            const sid = active.body.semester.id;
            const truth = (await pool.query(
                `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'approved')::int AS approved,
                        count(*)::int AS total,
                        count(*) FILTER (WHERE status IN ('approved', 'rejected') AND decided_by_role IN ('reviewer', 'admin'))::int AS decided
                 FROM applications WHERE semester_id = $1`, [sid]
            )).rows[0];
            const a = active.body.analytics;
            report(active.body.semester.status === 'active' && a.status.overall.pending === truth.pending && a.status.overall.approved === truth.approved
                && a.status.overall.total === truth.total && a.turnaround.overall.decided === truth.decided,
            'Active semester (the default): the numbers match an independent count', `${a.status.overall.total}/${truth.total}`);
            report(active.body.semesters.every((x) => ['active', 'closed'].includes(x.status)), 'Only active and closed semesters to choose from');
        }

        // CSV
        const csv = await fetch(`${API}/admin/analytics/export.csv?semester_id=${closedId}&table=turnaround&lang=en`, { headers: { Authorization: `Bearer ${S}` } });
        const bytes = Buffer.from(await csv.arrayBuffer());
        const csvLines = bytes.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
        report(csv.status === 200 && bytes[0] === 0xEF && csvLines[0].startsWith('"Programme";') && csvLines.at(-1).startsWith('"All programmes";"2";"3";"3";"2";"2"'),
            'CSV export of a table: header, rows and the overall line', csvLines.at(-1));

        // "Review deadline soon / passed" (round 2 Group 1): from 7 days before the review deadline while
        // something is undecided; after it, the undecided counts per programme and NOTHING rejected
        const sid = (await pool.query("SELECT id FROM semesters WHERE status = 'active' ORDER BY applications_open_at LIMIT 1")).rows[0]?.id;
        if (!sid) {
            skip('"Review deadline" warnings', 'no semester in progress');
        } else {
            semesterBackup = (await pool.query('SELECT id, applications_open_at, applications_close_at, review_end_at, end_date, close_reason, last_days_warning_days FROM semesters WHERE id = $1', [sid])).rows[0];
            // One undecided application of our own, so the warning always has something to show
            const own = (await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id)
                 VALUES ($1, $2, '[]', $3, $4, 'pending', $5) RETURNING id`,
                [d.studentA.id, d.studentA.programme_id, JSON.stringify([{ course_code: `SECRD${stamp}`, course_name: 'Review deadline check', credits: 1 }]), `SECRD${stamp}`.toUpperCase().slice(0, 20), sid]
            )).rows[0].id;
            tempApplicationIds.push(own);
            const undecided = (await pool.query("SELECT count(*)::int AS n FROM applications WHERE semester_id = $1 AND status IN ('pending', 'needs_info')", [sid])).rows[0].n;
            const setReview = (offset) => pool.query(
                `UPDATE semesters SET applications_open_at = ((now() AT TIME ZONE 'Europe/Budapest')::date - 60)::timestamp AT TIME ZONE 'Europe/Budapest',
                     applications_close_at = ((now() AT TIME ZONE 'Europe/Budapest')::date - 30)::timestamp AT TIME ZONE 'Europe/Budapest',
                     review_end_at = (((now() AT TIME ZONE 'Europe/Budapest')::date + $2::int)::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest'
                 WHERE id = $1`, [sid, offset]);
            const entry = async () => ((await call('GET', 'admin/summary', { token: S })).body?.summary?.semesters || []).find((x) => x.id === sid);
            await setReview(10);
            const far = await entry();
            report(far && !far.reviewSoon && !far.reviewPassed, '"Review deadline soon": not 10 days before it', JSON.stringify(far && { soon: far.reviewSoon, passed: far.reviewPassed }));
            await setReview(3);
            const near = await entry();
            report(near?.reviewSoon === true && near.pending + near.needsInfo === undecided, '"Review deadline soon": 3 days before, with both numbers', JSON.stringify(near && { soon: near.reviewSoon, pending: near.pending, needsInfo: near.needsInfo }));
            await setReview(-5);
            const after = await entry();
            const perProgramme = (after?.undecidedByProgramme || []).reduce((n, p) => n + p.pending + p.needs_info, 0);
            report(after?.reviewPassed === true && perProgramme === undecided, '"Review deadline passed": the undecided counts per programme', JSON.stringify(after?.undecidedByProgramme));
            report((await pool.query('SELECT status FROM applications WHERE id = $1', [own])).rows[0].status === 'pending', 'Nothing rejected at the review deadline');
            // Only this semester's dates back (the temporary semesters go at the end of this section)
            const b = semesterBackup;
            await pool.query('UPDATE semesters SET applications_open_at = $2, applications_close_at = $3, end_date = $4, close_reason = $5, last_days_warning_days = $6, review_end_at = $7 WHERE id = $1',
                [b.id, b.applications_open_at, b.applications_close_at, b.end_date, b.close_reason, b.last_days_warning_days, b.review_end_at]);
            semesterBackup = null;
            await removeTempApplications();
        }

        // The PDF book with the decision line: generate it for the closed test semester
        const book = await call('POST', `admin/past-semesters/${closedId}/book`, { token: S });
        report(book.status === 200 && !!book.body.book, 'An older semester\'s PDF book is generated again with the decision line', `${book.status}`);
        const bookName = (await pool.query('SELECT book_name FROM semesters WHERE id = $1', [closedId])).rows[0].book_name;
        if (bookName) await minioClient.removeObject(ARCHIVE_BUCKET, bookName).catch(() => {});

        await pool.query('DELETE FROM applications WHERE semester_id = $1', [closedId]);
        const removedStudents = await removeTestStudents();
        await restoreSemesters();
        console.log(`(removed the temporary semesters, ${removedStudents} student(s) and the PDF book)`);
    }

    section('4r. Staff linked to programmes (round 2 Group 1): one main per programme, extra reviewers on standby or assisting');
    {
        const programmeOfB = d.studentB.programme_id; // d.reviewer is its main reviewer
        const programmeOfA = d.studentA.programme_id;
        const codeOf = async (id) => (await pool.query('SELECT code FROM programmes WHERE id = $1', [id])).rows[0].code;
        const codeOfB = await codeOf(programmeOfB);
        const stamp = Date.now().toString(36);
        const email = (n) => `${STAFF_TEST_PREFIX}${n}-${stamp}${TEST_DOMAIN}`;
        const invite = (json) => call('POST', 'users/invites', { token: S, json: { role: 'reviewer', ...json } });
        const tokenOf = (link) => String(link || '').split('/invite/')[1] || '';
        const dbRefuses = async (sql, params, constraint) => {
            try {
                await pool.query(sql, params);
                return false;
            } catch (err) {
                return err.constraint === constraint;
            }
        };
        try {
            // Database rules
            report(await dbRefuses("INSERT INTO staff_programmes (user_id, programme_id, role) VALUES ($1, $2, 'main')", [d.admin.id, programmeOfB], 'staff_programmes_one_main'),
                'The database refuses a second main reviewer for a programme (staff_programmes_one_main)');
            report(await dbRefuses('UPDATE users SET programme_id = $2 WHERE id = $1', [d.reviewer.id, programmeOfB], 'users_programme_only_students'),
                "The database refuses a programme on a reviewer's account (users_programme_only_students)");
            report(await dbRefuses("INSERT INTO staff_programmes (user_id, programme_id, role, can_assist) VALUES ($1, $2, 'main', true)", [d.admin.id, programmeOfA], 'staff_programmes_assist_only_extra'),
                'The database refuses "allowed to assist" on a main reviewer');

            // Invite choices
            await expect('Invite: an extra reviewer that replaces someone', invite({ email: email('x'), programmes: [{ code: codeOfB, role: 'extra', replace: true }] }), 400, 'REPLACE_ONLY_MAIN');
            await expect('Invite: the same programme twice', invite({ email: email('x'), programmes: [{ code: codeOfB, role: 'extra' }, { code: codeOfB, role: 'main' }] }), 400, 'DUPLICATE_PROGRAMME');
            await expect('Invite: an unknown role in a programme', invite({ email: email('x'), programmes: [{ code: codeOfB, role: 'boss' }] }), 400, 'INVALID_STAFF_ROLE');
            await expect('Invite: a second main reviewer without replace', invite({ email: email('x'), programmes: [{ code: codeOfB, role: 'main' }] }), 409, 'PROGRAMME_HAS_REVIEWER');
            await expect('Invite: no programme at all', invite({ email: email('x'), programmes: [] }), 400, 'INVALID_PROGRAMME');

            // An extra reviewer never replaces anyone
            const created = await invite({ email: email('extra'), programmes: [{ code: codeOfB, role: 'extra' }], language: 'en' });
            report(created.status === 201 && created.body.invite.programmes.length === 1 && created.body.invite.programmes[0].role === 'extra',
                'Invite an extra reviewer for a programme that has a main one: created, role extra', `${created.status} ${created.code || ''}`);
            const page = await call('GET', `invites/${tokenOf(created.body?.link)}`);
            report(page.status === 200 && page.body.invite.programmes?.[0]?.role === 'extra' && page.body.invite.programmes[0].code === codeOfB,
                'The accept page shows the programme and the role', `${page.status}`);
            await expect('Accept the extra invite', call('POST', `invites/${tokenOf(created.body?.link)}/accept`, { json: { name: 'Security Check Extra', password: 'LongEnough1' } }), 200);
            const extra = (await pool.query("SELECT id, role FROM users WHERE email = $1", [email('extra')])).rows[0];
            const main = (await pool.query(
                "SELECT u.id, u.deactivated_at FROM staff_programmes sp JOIN users u ON u.id = sp.user_id WHERE sp.programme_id = $1 AND sp.role = 'main' AND sp.ended_at IS NULL", [programmeOfB]
            )).rows[0];
            report(main && main.id === d.reviewer.id && !main.deactivated_at, 'The main reviewer is still the main reviewer, still active', `#${main?.id}`);
            await expect('The main reviewer keeps full access', call('GET', 'reviewer/applications', { token: R }), 200);

            // An open application of the programme, naming one of student B's files
            const code = `SECX${stamp}`.toUpperCase().slice(0, 20);
            const temp = (await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, fulfilled_courses_json, target_courses, target_course_code, status, student_note)
                 VALUES ($1, $2, '[]', $3, $4, $5, 'pending', 'Temporary application of the security check') RETURNING id`,
                [d.studentA.id, programmeOfB, JSON.stringify([{ course_name: 'Security check', file: d.fileOfB }]),
                    JSON.stringify([{ course_code: code, course_name: 'Security check', credits: 1 }]), code]
            )).rows[0].id;
            tempApplicationIds.push(temp);
            const X = tokenFor(extra);
            const sees = async () => {
                const list = await call('GET', 'reviewer/applications', { token: X });
                const all = await call('GET', 'applications', { token: X });
                const details = await call('GET', `reviewer/applications/${temp}`, { token: X });
                const file = await call('GET', `uploads/${encodeURIComponent(d.fileOfB)}`, { token: X });
                return {
                    inList: (list.body?.applications || []).some((a) => a.id === temp),
                    inAll: (all.body?.applications || []).some((a) => a.id === temp),
                    details: details.status, file: file.status, header: list.body?.reviewer, listStatus: list.status, allStatus: all.status,
                };
            };

            // Standby (allowed to assist off): nothing of the programme
            const standby = await sees();
            report(!standby.inList && !standby.inAll, 'A standby extra reviewer does not see the programme\'s applications (dashboard and list)');
            report(standby.details === 404, 'A standby extra reviewer cannot open an application of the programme (404)', `${standby.details}`);
            report(standby.file === 404, 'A standby extra reviewer cannot open a file of the programme (404)', `${standby.file}`);
            report(standby.header?.programmes?.[0]?.sees === false && standby.header.programmes[0].role === 'extra',
                'The dashboard tells the standby extra reviewer their role (sees: false)', JSON.stringify(standby.header?.programmes || []));

            // Assisting: sees and can open (read from the database on the next request, no new login)
            await pool.query("UPDATE staff_programmes SET can_assist = true WHERE user_id = $1 AND programme_id = $2 AND ended_at IS NULL", [extra.id, programmeOfB]);
            const assisting = await sees();
            report(assisting.inList && assisting.inAll, 'An assisting extra reviewer sees the programme\'s applications (from the next request on)', `dashboard ${assisting.inList} (${assisting.listStatus}), list ${assisting.inAll} (${assisting.allStatus})`);
            report(assisting.details === 200 && assisting.file === 200, 'An assisting extra reviewer opens the application and its file', `${assisting.details} / ${assisting.file}`);
            await pool.query("UPDATE staff_programmes SET can_assist = false WHERE user_id = $1 AND programme_id = $2 AND ended_at IS NULL", [extra.id, programmeOfB]);
            report((await sees()).details === 404, 'Assisting turned off: the application is out of reach again at once');

            // The admin's link actions (no invite for an existing account)
            const link = (json) => call('POST', `users/${extra.id}/programmes`, { token: S, json });
            await expect('Link: same role again', link({ programme_code: codeOfB, role: 'extra' }), 409, 'ALREADY_LINKED');
            await expect('Link: main without replace while there is one', link({ programme_code: codeOfB, role: 'main' }), 409, 'PROGRAMME_HAS_REVIEWER');
            await expect('Link: unknown programme', link({ programme_code: 'NOPE', role: 'extra' }), 400, 'INVALID_PROGRAMME');
            await expect('Link: reviewer only (an admin account)', call('POST', `users/${d.admin.id}/programmes`, { token: S, json: { programme_code: codeOfB, role: 'extra' } }), 400, 'NOT_A_REVIEWER');
            await expect('Link: a reviewer cannot change links', call('POST', `users/${extra.id}/programmes`, { token: R, json: { programme_code: codeOfB, role: 'extra' } }), 403, 'FORBIDDEN_ROLE');
            await expect("Unlink: the reviewer's only programme", call('DELETE', `users/${extra.id}/programmes/${codeOfB}`, { token: S }), 409, 'LAST_PROGRAMME');
            if (programmeOfA !== programmeOfB) {
                const codeOfA = await codeOf(programmeOfA);
                const second = await link({ programme_code: codeOfA, role: 'extra' });
                report(second.status === 201, 'Link the extra reviewer to a second programme (any number allowed)', `${second.status} ${second.code || ''}`);
                const links = (await pool.query('SELECT count(*)::int AS n FROM staff_programmes WHERE user_id = $1 AND ended_at IS NULL', [extra.id])).rows[0].n;
                report(links === 2, 'Two current links', `${links}`);
                await expect('Unlink one of two programmes', call('DELETE', `users/${extra.id}/programmes/${codeOfA}`, { token: S }), 200);
            } else {
                skip('Link the extra reviewer to a second programme', 'students A and B are in the same programme');
            }
            // Removing the reviewer ends every link (kept for history)
            await expect('Remove the extra reviewer', call('PUT', `users/${extra.id}/remove-reviewer`, { token: S }), 200);
            const ended = (await pool.query('SELECT count(*) FILTER (WHERE ended_at IS NULL)::int AS current, count(*)::int AS kept FROM staff_programmes WHERE user_id = $1', [extra.id])).rows[0];
            report(ended.current === 0 && ended.kept >= 1, 'A removed reviewer has no current link; the ended links are kept', `${ended.current} current, ${ended.kept} kept`);
        } finally {
            await removeTempApplications();
            const removed = await removeTestStaff();
            console.log(`(removed ${removed} temporary extra reviewer(s) with their links and invites)`);
        }
    }

    section('4s. Sharing work (round 2 Group 1): assist, assign, distribute, first decision wins, main reviewer gone');
    {
        const stamp = Date.now().toString(36).toUpperCase();
        const code = `${SHARING_PROGRAMME_PREFIX}${stamp}`.slice(0, 20);
        try {
            const programmeId = (await pool.query(
                "INSERT INTO programmes (code, name_en, name_hu, name_de) VALUES ($1, 'Security Check Sharing', 'Security Check Sharing', 'Security Check Sharing') RETURNING id", [code]
            )).rows[0].id;
            const person = async (key, role, canAssist = false) => {
                const user = (await pool.query(
                    "INSERT INTO users (name, email, password, role, is_verified) VALUES ($1, $2, 'not-a-password-hash', 'reviewer', true) RETURNING id, role, name",
                    [`Sharing ${key}`, `${STAFF_TEST_PREFIX}share-${key}-${stamp.toLowerCase()}${TEST_DOMAIN}`]
                )).rows[0];
                await pool.query('INSERT INTO staff_programmes (user_id, programme_id, role, can_assist) VALUES ($1, $2, $3, $4)', [user.id, programmeId, role, canAssist]);
                return user;
            };
            const M = await person('main', 'main');
            const E1 = await person('assist', 'extra', true);
            const E2 = await person('standby', 'extra', false);
            const student = (await pool.query(
                `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
                 VALUES ('Security Check Sharing Student', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id`,
                [`share-student-${stamp.toLowerCase()}${TEST_DOMAIN}`, `Q${stamp.slice(-5)}`.padEnd(6, 'Q').slice(0, 6), programmeId]
            )).rows[0];
            const app = async (n, status) => (await pool.query(
                `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, student_note,
                     info_requested_at, info_deadline)
                 VALUES ($1, $2, '[]', $3, $4, $5::varchar, 'Temporary application of the security check',
                         CASE WHEN $5::varchar = 'needs_info' THEN now() END, CASE WHEN $5::varchar = 'needs_info' THEN now() + interval '2 days' END) RETURNING id`,
                [student.id, programmeId, JSON.stringify([{ course_code: `SHR${n}`, course_name: 'Security check', credits: 1 }]), `SHR${n}${stamp}`.slice(0, 20), status]
            )).rows[0].id;
            const [a1, a2, a3, a4] = [await app(1, 'pending'), await app(2, 'pending'), await app(3, 'pending'), await app(4, 'pending')];
            const a5 = await app(5, 'needs_info');
            const withdrawn = await app(6, 'withdrawn');
            // Any application of another programme (its status does not matter: it is not this programme's)
            const otherProgrammeApp = await app(7, 'pending').then(async (id) => {
                await pool.query('UPDATE applications SET programme_id = $2 WHERE id = $1', [id, d.studentB.programme_id]);
                tempApplicationIds.push(id);
                return id;
            });
            const [TM, TE1, TE2] = [tokenFor(M), tokenFor(E1), tokenFor(E2)];
            const base = `admin/sharing/${code}`;
            const assigned = async (id) => (await pool.query('SELECT assigned_reviewer_id FROM applications WHERE id = $1', [id])).rows[0].assigned_reviewer_id;

            // Only the admin
            await expect('Reviewer: the sharing panel', call('GET', base, { token: TM }), 403, 'FORBIDDEN_ROLE');
            await expect('Reviewer: assign applications', call('POST', `${base}/assign`, { token: TM, json: { application_ids: [a1], reviewer_id: M.id } }), 403, 'FORBIDDEN_ROLE');
            await expect('Student: turn assisting on', call('PUT', `${base}/assist/${E2.id}`, { token: A, json: { can_assist: true } }), 403, 'FORBIDDEN_ROLE');
            const panel = await call('GET', base, { token: S });
            report(panel.status === 200 && panel.body.reviewers.length === 3 && panel.body.applications.length === 5
                && !panel.body.applications.some((x) => x.id === withdrawn) && !JSON.stringify(panel.body).includes('@'),
            'Admin: the programme\'s 3 reviewers and its 5 open applications (no withdrawn one, no email addresses)', `${panel.status} ${panel.body?.reviewers?.length}/${panel.body?.applications?.length}`);

            // Assigning: only to someone who can see the programme, only open applications of it, all or nothing
            await expect('Assign to a standby extra reviewer', call('POST', `${base}/assign`, { token: S, json: { application_ids: [a1], reviewer_id: E2.id } }), 409, 'REVIEWER_CANNOT_SEE');
            await expect('Assign to a reviewer of another programme', call('POST', `${base}/assign`, { token: S, json: { application_ids: [a1], reviewer_id: d.reviewer.id } }), 409, 'REVIEWER_CANNOT_SEE');
            await expect('Assign a withdrawn application (with an open one)', call('POST', `${base}/assign`, { token: S, json: { application_ids: [a1, withdrawn], reviewer_id: M.id } }), 409, 'NOT_ASSIGNABLE');
            report(await assigned(a1) === null, 'All or nothing: the open application was not assigned either');
            if (otherProgrammeApp) await expect('Assign another programme\'s application', call('POST', `${base}/assign`, { token: S, json: { application_ids: [otherProgrammeApp], reviewer_id: M.id } }), 409, 'NOT_ASSIGNABLE');
            else skip('Assign another programme\'s application', 'no open application in student B\'s programme');
            await expect('Assign with a broken id list', call('POST', `${base}/assign`, { token: S, json: { application_ids: [a1, a1], reviewer_id: M.id } }), 400, 'INVALID_FIELD');
            await expect('Assign a1 to the assisting extra reviewer', call('POST', `${base}/assign`, { token: S, json: { application_ids: [a1], reviewer_id: E1.id } }), 200);
            const mainList = await call('GET', 'reviewer/applications', { token: TM });
            const row = (mainList.body?.applications || []).find((x) => x.id === a1);
            report(row && row.assigned_reviewer_id === E1.id && row.assigned_name === E1.name,
                'The main reviewer still sees it, marked "Assigned to" the extra reviewer', row ? `${row.assigned_name}` : 'missing');
            const standbyList = await call('GET', 'reviewer/applications', { token: TE2 });
            report(standbyList.status === 200 && (standbyList.body.applications || []).length === 0, 'The standby extra reviewer sees nothing of the programme');

            // Distribute evenly: the unassigned PENDING ones (a2, a3, a4), each to the ticked reviewer with the fewest
            const spread = await call('POST', `${base}/distribute`, { token: S, json: { reviewer_ids: [M.id, E1.id] } });
            const totals = Object.fromEntries((spread.body?.perReviewer || []).map((x) => [x.reviewer_id, x.total]));
            report(spread.status === 200 && spread.body.distributed === 3 && totals[M.id] === 2 && totals[E1.id] === 2,
                'Distribute evenly: 3 unassigned pending applications, 2 open each afterwards (a1 counted)', `${spread.status} ${JSON.stringify(totals)}`);
            report(await assigned(a5) === null, 'Distribute leaves needs-info applications alone');
            await expect('Distribute to a standby reviewer', call('POST', `${base}/distribute`, { token: S, json: { reviewer_ids: [M.id, E2.id] } }), 409, 'REVIEWER_CANNOT_SEE');
            await expect('Unassign a2 (shared again)', call('POST', `${base}/assign`, { token: S, json: { application_ids: [a2], reviewer_id: null } }), 200);
            report(await assigned(a2) === null, 'a2 is shared again');

            // First decision wins: two reviewers approve the same application at the same moment
            const target = a3;
            const decide = (token) => call('PUT', `applications/${target}/status`, { token, json: { status: 'approved', final_grade: 4, note: 'Security check' } });
            const [first, second] = await Promise.all([decide(TM), decide(TE1)]);
            const statuses = [first.status, second.status].sort();
            report(statuses[0] === 200 && statuses[1] === 409 && [first.code, second.code].includes('ALREADY_DECIDED'),
                'Two reviewers deciding at once: one 200, the other 409 ALREADY_DECIDED', `${first.status} ${first.code || ''} / ${second.status} ${second.code || ''}`);

            // Assisting off: their open assigned applications become shared, and out of reach at once
            const e1Open = (await pool.query("SELECT array_agg(id) AS ids FROM applications WHERE assigned_reviewer_id = $1 AND status IN ('pending', 'needs_info')", [E1.id])).rows[0].ids || [];
            const off = await call('PUT', `${base}/assist/${E1.id}`, { token: S, json: { can_assist: false } });
            report(off.status === 200 && off.body.unassigned === e1Open.length, 'Assisting off: their open assigned applications become shared', `${off.status} ${off.body?.unassigned}/${e1Open.length}`);
            report(e1Open.length === 0 || (await pool.query('SELECT count(*)::int AS n FROM applications WHERE id = ANY($1) AND assigned_reviewer_id IS NOT NULL', [e1Open])).rows[0].n === 0, 'None of them is assigned now');
            await expect('Standby again: the application is out of reach', call('GET', `reviewer/applications/${a1}`, { token: TE1 }), 404, 'APPLICATION_NOT_FOUND');
            await expect('Assist on a main reviewer', call('PUT', `${base}/assist/${M.id}`, { token: S, json: { can_assist: true } }), 400, 'ASSIST_ONLY_EXTRA');
            await expect('Assist with a broken value', call('PUT', `${base}/assist/${E1.id}`, { token: S, json: { can_assist: 'yes' } }), 400, 'INVALID_FIELD');
            await expect('Assist on again', call('PUT', `${base}/assist/${E1.id}`, { token: S, json: { can_assist: true } }), 200);

            // The main reviewer leaves while an extra reviewer assists: nobody is promoted, the extra keeps working, the admin is warned
            const summaryBefore = (await call('GET', 'admin/summary', { token: S })).body?.summary;
            await expect('Remove the main reviewer', call('PUT', `users/${M.id}/remove-reviewer`, { token: S }), 200);
            const mains = (await pool.query("SELECT count(*)::int AS n FROM staff_programmes WHERE programme_id = $1 AND role = 'main' AND ended_at IS NULL", [programmeId])).rows[0].n;
            report(mains === 0, 'No automatic promotion: the programme has no main reviewer now');
            await expect('The assisting extra reviewer keeps working', call('GET', `reviewer/applications/${a1}`, { token: TE1 }), 200);
            const summaryAfter = (await call('GET', 'admin/summary', { token: S })).body?.summary;
            report(summaryAfter?.programmesWithoutMain === (summaryBefore?.programmesWithoutMain ?? 0) + 1,
                'The admin summary counts the programme without a main reviewer (Overview warning, menu badge)', `${summaryBefore?.programmesWithoutMain} -> ${summaryAfter?.programmesWithoutMain}`);
            // Standby too: nobody can see it now, it waits for the admin
            await call('PUT', `${base}/assist/${E1.id}`, { token: S, json: { can_assist: false } });
            const summaryNobody = (await call('GET', 'admin/summary', { token: S })).body?.summary;
            report(summaryNobody?.programmesWithoutReviewer === (summaryBefore?.programmesWithoutReviewer ?? 0) + 1,
                'With only standby extra reviewers nobody can review it: counted as a programme without a reviewer', `${summaryBefore?.programmesWithoutReviewer} -> ${summaryNobody?.programmesWithoutReviewer}`);
            // The admin chooses: make an extra reviewer the main one
            await expect('Make the standby extra reviewer the main one', call('POST', `users/${E2.id}/programmes`, { token: S, json: { programme_code: code, role: 'main' } }), 200);
            await expect('The new main reviewer sees the programme', call('GET', `reviewer/applications/${a1}`, { token: TE2 }), 200);
        } finally {
            const removed = await removeSharingProgramme();
            console.log(`(removed the temporary sharing programme (${removed}) with its reviewers, student and applications)`);
        }
    }

    section('4t. PDFs for reviewers and admins (round 2 Group 1): own programmes only, checked on the server');
    {
        const stamp = Date.now().toString(36);
        const pdf = async (path, token) => {
            const res = await fetch(`${API}/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
            const bytes = Buffer.from(await res.arrayBuffer());
            const isPdf = bytes.subarray(0, 4).toString() === '%PDF';
            let code = null;
            if (!isPdf) { try { code = JSON.parse(bytes.toString('utf8')).code; } catch { code = null; } }
            return { status: res.status, isPdf, code, type: res.headers.get('content-type') || '' };
        };
        const programmeOfB = d.studentB.programme_id;
        const inProgress = (await pool.query("SELECT id FROM semesters WHERE status = 'active' ORDER BY applications_open_at LIMIT 1")).rows[0]?.id;
        // One pending application of our own in the reviewer's programme (removed at the end of this section)
        const ownCode = `SECPDO${stamp}`.toUpperCase().slice(0, 20);
        const ownApp = (await pool.query(
            `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status)
             VALUES ($1, $2, '[]', $3, $4, 'pending') RETURNING id`,
            [d.studentA.id, programmeOfB, JSON.stringify([{ course_code: ownCode, course_name: 'PDF check' }]), ownCode]
        )).rows[0].id;
        tempApplicationIds.push(ownApp);
        const otherApp = (await pool.query("SELECT id FROM applications WHERE programme_id <> $1 ORDER BY id LIMIT 1", [programmeOfB])).rows[0]?.id;

        for (const path of ['reviewer/book.pdf?semester=1', 'reviewer/applications/1/pdf', 'admin/applications/1/pdf']) {
            const noToken = await pdf(path);
            report(noToken.status === 401 && noToken.code === 'NO_TOKEN', `No token: GET /api/${path} -> 401`, `${noToken.status}`);
            const student = await pdf(path, A);
            report(student.status === 403 && student.code === 'FORBIDDEN_ROLE', `Student: GET /api/${path} -> 403`, `${student.status}`);
        }
        const reviewerOnAdmin = await pdf('admin/applications/1/pdf', R);
        report(reviewerOnAdmin.status === 403, 'Reviewer: the admin\'s application PDF -> 403', `${reviewerOnAdmin.status}`);

        if (inProgress) {
            const book = await pdf(`reviewer/book.pdf?semester=${inProgress}`, R);
            report(book.status === 200 && book.isPdf && book.type.includes('application/pdf'), 'Reviewer: the book of their programmes for the semester in progress (interim)', `${book.status}`);
        } else skip('Reviewer: the interim book', 'no semester in progress');
        const noSemester = await pdf('reviewer/book.pdf', R);
        report(noSemester.status === 404 && noSemester.code === 'SEMESTER_NOT_FOUND', 'Reviewer book without a semester -> 404', `${noSemester.status}`);
        const setup = (await pool.query("SELECT id FROM semesters WHERE status = 'setup' LIMIT 1")).rows[0]?.id;
        if (setup) {
            const res = await pdf(`reviewer/book.pdf?semester=${setup}`, R);
            report(res.status === 404 && res.code === 'SEMESTER_NOT_FOUND', 'Reviewer book of a semester in setup -> 404', `${res.status}`);
        }
        if (ownApp) {
            const own = await pdf(`reviewer/applications/${ownApp}/pdf`, R);
            report(own.status === 200 && own.isPdf, 'Reviewer: one application of their programme as a PDF', `${own.status}`);
            const admin = await pdf(`admin/applications/${ownApp}/pdf`, S);
            report(admin.status === 200 && admin.isPdf, 'Admin: the same application as a PDF', `${admin.status}`);
        } else skip('Single application PDFs', 'no application in student B\'s programme');
        if (otherApp) {
            const other = await pdf(`reviewer/applications/${otherApp}/pdf`, R);
            report(other.status === 404 && other.code === 'APPLICATION_NOT_FOUND', "Reviewer: another programme's application PDF -> 404 (like one that doesn't exist)", `${other.status}`);
        } else skip("Reviewer: another programme's application PDF", 'no application in another programme');
        const unknown = await pdf('admin/applications/999999999/pdf', S);
        report(unknown.status === 404 && unknown.code === 'APPLICATION_NOT_FOUND', 'Admin: an application that does not exist -> 404', `${unknown.status}`);

        // A withdrawn application of the reviewer's programme is not shown to reviewers
        const code = `SECPDF${stamp}`.toUpperCase().slice(0, 20);
        const withdrawn = (await pool.query(
            `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status)
             VALUES ($1, $2, '[]', $3, $4, 'withdrawn') RETURNING id`,
            [d.studentA.id, programmeOfB, JSON.stringify([{ course_code: code, course_name: 'PDF check' }]), code]
        )).rows[0].id;
        tempApplicationIds.push(withdrawn);
        const w = await pdf(`reviewer/applications/${withdrawn}/pdf`, R);
        report(w.status === 404, 'Reviewer: a withdrawn application PDF -> 404', `${w.status}`);
        const wAdmin = await pdf(`admin/applications/${withdrawn}/pdf`, S);
        report(wAdmin.status === 200 && wAdmin.isPdf, 'Admin: a withdrawn application PDF (as in the admin\'s book)', `${wAdmin.status}`);

        // A standby extra reviewer of the programme gets nothing
        try {
            const standby = (await pool.query(
                "INSERT INTO users (name, email, password, role, is_verified) VALUES ('PDF Standby', $1, 'not-a-password-hash', 'reviewer', true) RETURNING id, role",
                [`${STAFF_TEST_PREFIX}pdf-${stamp}${TEST_DOMAIN}`]
            )).rows[0];
            await pool.query("INSERT INTO staff_programmes (user_id, programme_id, role, can_assist) VALUES ($1, $2, 'extra', false)", [standby.id, programmeOfB]);
            const T = tokenFor(standby);
            if (inProgress) {
                const book = await pdf(`reviewer/book.pdf?semester=${inProgress}`, T);
                report(book.status === 404 && book.code === 'NO_PROGRAMME', 'Standby extra reviewer: no book -> 404 NO_PROGRAMME', `${book.status} ${book.code}`);
            }
            if (ownApp) {
                const one = await pdf(`reviewer/applications/${ownApp}/pdf`, T);
                report(one.status === 404, 'Standby extra reviewer: no application PDF -> 404', `${one.status}`);
            }
        } finally {
            await removeTempApplications();
            await removeTestStaff();
        }
    }

    section('4u. The committee role (round 2 Group 2 Part A): invites, links on their own side, access from current links');
    {
        const stamp = Date.now().toString(36);
        const programmeOfB = d.studentB.programme_id;
        const codeOfB = (await pool.query('SELECT code FROM programmes WHERE id = $1', [programmeOfB])).rows[0].code;
        const email = (n) => `${STAFF_TEST_PREFIX}cm-${n}-${stamp}${TEST_DOMAIN}`;
        const invite = (json) => call('POST', 'users/invites', { token: S, json: { role: 'committee', ...json } });
        const tokenOf = (link) => String(link || '').split('/invite/')[1] || '';
        try {
            // Invites
            await expect('Committee invite with a main reviewer link', invite({ email: email('x'), programmes: [{ code: codeOfB, role: 'main' }] }), 400, 'INVALID_STAFF_ROLE');
            await expect('Committee invite without a programme', invite({ email: email('x'), programmes: [] }), 400, 'INVALID_PROGRAMME');
            await expect('Committee invite that replaces someone', invite({ email: email('x'), programme_code: codeOfB, replace: true }), 400, 'REPLACE_ONLY_MAIN');
            await expect('Reviewer: invite a committee member', call('POST', 'users/invites', { token: R, json: { role: 'committee', email: email('x'), programme_code: codeOfB } }), 403, 'FORBIDDEN_ROLE');
            const created = await invite({ email: email('member'), programme_code: codeOfB, language: 'en' });
            report(created.status === 201 && created.body.invite.role === 'committee' && created.body.invite.programmes?.[0]?.role === 'committee',
                'Committee invite (short form): created, the programme as a committee link', `${created.status} ${created.code || ''}`);
            const page = await call('GET', `invites/${tokenOf(created.body?.link)}`);
            report(page.status === 200 && page.body.invite.role === 'committee' && page.body.invite.programmes?.[0]?.role === 'committee', 'The accept page shows a committee invite');
            await expect('Accept the committee invite', call('POST', `invites/${tokenOf(created.body?.link)}/accept`, { json: { name: 'Security Check Member', password: 'LongEnough1' } }), 200);
            const member = (await pool.query('SELECT id, role, programme_id FROM users WHERE email = $1', [email('member')])).rows[0];
            const links = (await pool.query('SELECT role FROM staff_programmes WHERE user_id = $1 AND ended_at IS NULL', [member.id])).rows.map((r) => r.role);
            report(member.role === 'committee' && member.programme_id === null && JSON.stringify(links) === '["committee"]',
                'The account: role committee, no users.programme_id, one committee link', JSON.stringify({ role: member.role, links }));
            const M = tokenFor(member);

            // Access from the current links
            const me = await call('GET', 'committee/me', { token: M });
            report(me.status === 200 && me.body.programmes.length === 1 && me.body.programmes[0].code === codeOfB && !JSON.stringify(me.body).includes('@'),
                'The member sees their committee programme (no email addresses)', `${me.status}`);
            await expect('Committee page without a token', call('GET', 'committee/me'), 401, 'NO_TOKEN');
            await expect('Committee page as a student', call('GET', 'committee/me', { token: A }), 403, 'FORBIDDEN_ROLE');
            await expect('Committee page as a reviewer without committee links', call('GET', 'committee/me', { token: R }), 403, 'FORBIDDEN_ROLE');
            await expect('Committee page as the admin', call('GET', 'committee/me', { token: S }), 403, 'FORBIDDEN_ROLE');
            await expect('A committee member on the reviewer dashboard', call('GET', 'reviewer/applications', { token: M }), 403, 'FORBIDDEN_ROLE');
            await expect('A committee member on the applications list', call('GET', 'applications', { token: M }), 403, 'FORBIDDEN_ROLE');
            await expect('A committee member on an admin route', call('GET', 'admin/summary', { token: M }), 403, 'FORBIDDEN_ROLE');
            await expect('A committee member: a reviewer link', call('POST', `users/${member.id}/programmes`, { token: S, json: { programme_code: codeOfB, role: 'main' } }), 400, 'COMMITTEE_ONLY');
            const staff = (await call('GET', 'users/staff', { token: S })).body?.staff || [];
            report(staff.some((p) => p.id === member.id && p.role === 'committee' && p.programmes.some((l) => l.role === 'committee')), 'The staff list shows the member with the committee link');

            // A reviewer joins the committee of their own programme: a second link, on its own side
            const joined = await call('POST', `users/${d.reviewer.id}/programmes`, { token: S, json: { programme_code: codeOfB, role: 'committee' } });
            report(joined.status === 201, "A reviewer joins their own programme's committee (no new account)", `${joined.status} ${joined.code || ''}`);
            await expect('The same committee link again', call('POST', `users/${d.reviewer.id}/programmes`, { token: S, json: { programme_code: codeOfB, role: 'committee' } }), 409, 'ALREADY_LINKED');
            const both = await call('GET', 'committee/me', { token: R });
            report(both.status === 200 && both.body.alsoReviewer === true, 'The reviewer now reaches the committee page too (the switch)', `${both.status}`);
            await expect('…and the reviewer dashboard as before', call('GET', 'reviewer/applications', { token: R }), 200);
            let refused = false;
            try { await pool.query("INSERT INTO staff_programmes (user_id, programme_id, role) VALUES ($1, $2, 'committee')", [d.reviewer.id, programmeOfB]); } catch (err) { refused = err.constraint === 'staff_programmes_one_current_link'; }
            report(refused, 'The database allows one current committee link per person and programme');
            await expect('End only the committee link', call('DELETE', `users/${d.reviewer.id}/programmes/${codeOfB}?side=committee`, { token: S }), 200);
            await expect('The committee page is closed again', call('GET', 'committee/me', { token: R }), 403, 'FORBIDDEN_ROLE');
            await expect('The reviewer link is untouched', call('GET', 'reviewer/applications', { token: R }), 200);
            await pool.query("DELETE FROM staff_programmes WHERE user_id = $1 AND role = 'committee'", [d.reviewer.id]); // leave no history row behind

            // The admin acts as the member; then the member is removed
            const acting = await call('POST', 'acting/start', { token: S, json: { userId: member.id } });
            report(acting.status === 200 && acting.body.role === 'committee', 'The admin acts as a committee member', `${acting.status} ${acting.code || ''}`);
            if (acting.body?.token) {
                await expect('Acting: the committee page', call('GET', 'committee/me', { token: acting.body.token }), 200);
                await call('POST', 'acting/exit', { token: acting.body.token });
            }
            await expect('Remove the committee member', call('PUT', `users/${member.id}/remove-reviewer`, { token: S }), 200);
            await expect('A removed member: the committee page', call('GET', 'committee/me', { token: M }), 401, 'ACCOUNT_DEACTIVATED');
            await expect('A removed member: login', call('POST', 'login', { json: { email: email('member'), password: 'LongEnough1' } }), 403, 'ACCOUNT_DEACTIVATED');
            const ended = (await pool.query('SELECT count(*) FILTER (WHERE ended_at IS NULL)::int AS current FROM staff_programmes WHERE user_id = $1', [member.id])).rows[0].current;
            report(ended === 0, 'Every committee link ended (kept for history)');
        } finally {
            await pool.query("DELETE FROM staff_programmes WHERE user_id = $1 AND role = 'committee'", [d.reviewer.id]);
            const removed = await removeTestStaff();
            console.log(`(removed ${removed} temporary committee member(s) and their invites)`);
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
    const programmes = await call('GET', 'programmes');
    report(programmes.status === 200 && Array.isArray(programmes.body?.programmes)
        && d.programmeCodes.every((code) => programmes.body.programmes.some((p) => p.code === code && p.name_en && p.name_hu && p.name_de)),
        'Programme list is public, with EN/HU/DE names', `${programmes.status}, ${programmes.body?.programmes?.length ?? 0} programmes`);
    const countries = await call('GET', 'countries');
    report(countries.status === 200 && Array.isArray(countries.body?.countries) && ['HU', 'AT', 'XK'].every((c) => countries.body.countries.includes(c))
        && countries.body.countries.every((c) => /^[A-Z]{2}$/.test(c)),
        'Country list is public, ISO codes only', `${countries.status}, ${countries.body?.countries?.length ?? 0} codes`);
    // Student registrations below are all refused before anything is saved (no account, no email)
    const newStudent = (extra) => ({ name: 'Security Check', email: `security-check-${Date.now()}${TEST_DOMAIN}`, password: 'x-Security-Check-1', programme_code: d.programmeCodes[0], ...extra });
    await expect('Register student without Neptun code', call('POST', 'register', { json: newStudent({}) }), 400, 'INVALID_NEPTUN');
    await expect('Register student with a 5-character Neptun code', call('POST', 'register', { json: newStudent({ neptun_code: 'ABC12' }) }), 400, 'INVALID_NEPTUN');
    await expect('Register student with symbols in the Neptun code', call('POST', 'register', { json: newStudent({ neptun_code: 'AB-12C' }) }), 400, 'INVALID_NEPTUN');
    await expect('Register student with an unknown programme', call('POST', 'register', { json: newStudent({ neptun_code: 'ZZZ999', programme_code: 'NOPE' }) }), 400, 'INVALID_PROGRAMME');
    await expect('Register student without a programme', call('POST', 'register', { json: newStudent({ neptun_code: 'ZZZ999', programme_code: undefined }) }), 400, 'INVALID_PROGRAMME');
    await expect('Register with an email that is not text', call('POST', 'register', { json: { name: 'x', email: 123, password: 'x' } }), 400, 'MISSING_FIELDS');
    if (d.studentA.neptun_code) {
        // Lower case and spaces must not get around the duplicate check
        await expect("Register student with someone else's Neptun code", call('POST', 'register', { json: newStudent({ neptun_code: ` ${d.studentA.neptun_code.toLowerCase()} ` }) }), 400, 'NEPTUN_TAKEN');
    } else {
        skip("Register student with someone else's Neptun code", 'student A has no Neptun code');
    }
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
    if (results.skip > 0) console.log('Skipped checks did NOT run: see the SKIP lines above for the reason.');
    return results.fail === 0;
};

// Removes this run's temporary applications and rate-limit rows and puts the drafts back, also after a crash
const finish = async (ok) => {
    try {
        await removeTempApplications();
    } catch (err) {
        console.error('Could not remove the temporary applications:', err.message);
    }
    try {
        await removeTestStudents();
    } catch (err) {
        console.error('Could not remove the temporary test student:', err.message);
    }
    try {
        await restoreClose();
    } catch (err) {
        console.error('Could not put back the semesters of section 4p:', err.message);
    }
    try {
        await restoreCatalogue();
    } catch (err) {
        console.error('Could not put back the catalogue of section 4n:', err.message);
    }
    try {
        await removeTestDomain();
    } catch (err) {
        console.error('Could not remove the test domain:', err.message);
    }
    try {
        await restoreAdmin();
        await removeTestAdmins();
    } catch (err) {
        console.error('Could not put back the admins of section 4l:', err.message);
    }
    try {
        await removeSharingProgramme();
    } catch (err) {
        console.error('Could not remove the temporary programme of section 4s:', err.message);
    }
    try {
        await removeTestStaff();
    } catch (err) {
        console.error('Could not remove the temporary extra reviewers of section 4r:', err.message);
    }
    try {
        const restored = await restoreReviewerAccess();
        if (restored !== 'nothing to put back') console.log(`(${restored})`);
    } catch (err) {
        console.error('Could not put back the reviewer access test data:', err.message);
    }
    try {
        await restoreSemesters();
    } catch (err) {
        console.error('Could not put back the semester times:', err.message);
    }
    try {
        await restoreDrafts();
    } catch (err) {
        console.error('Could not put back the drafts of students A and B:', err.message);
    }
    try {
        if (runStartedAt) await pool.query('DELETE FROM acting_sessions WHERE started_at >= $1', [runStartedAt]);
    } catch (err) {
        console.error('Could not remove this run\'s acting sessions:', err.message);
    }
    try {
        const removed = await cleanupRateLimitRows();
        if (removed) console.log(`(removed ${removed} rate-limit rows created by this run)`);
    } catch (err) {
        console.error('Could not remove this run\'s rate-limit rows:', err.message);
    }
    process.exit(ok ? 0 : 1);
};

run()
    .then(finish)
    .catch((err) => {
        console.error('Security check crashed:', err.message);
        return finish(false);
    });
