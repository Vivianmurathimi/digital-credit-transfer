/**
 * Security check for the API (Group 1, Step 10). See docs/SECURITY_TESTS.md.
 *
 * Run against a RUNNING backend:   npm run security-check
 * Other address:                   SECURITY_CHECK_URL=http://localhost:5099 npm run security-check
 *
 * Every request is either read-only or one the server must refuse before it saves anything
 * (also every withdraw request: only refused ones are sent). Section 4d adds two temporary
 * applications of student A (rejected, withdrawn) and deletes them again,
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

// ---------- temporary applications of section 4d (deleted at the end, also after a crash) ----------
const tempApplicationIds = [];
const removeTempApplications = async () => {
    if (tempApplicationIds.length === 0) return 0;
    // Deleting the application also deletes its history (the only way history entries can go)
    const { rowCount } = await pool.query('DELETE FROM applications WHERE id = ANY($1)', [tempApplicationIds.splice(0)]);
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
// Whether students can submit now: the semester's application period and the admin toggle (Group 3);
// an older backend only sends the toggle
const canSubmitNow = (settings) => (settings.body?.submission ? settings.body.submission.canSubmit === true : settings.body?.isOpen === true);

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
    const users = (await pool.query('SELECT id, role, email, neptun_code, programme_id FROM users ORDER BY id')).rows;
    const programmeCodes = (await pool.query('SELECT code FROM programmes ORDER BY code')).rows.map((p) => p.code);
    const apps = (await pool.query('SELECT id, student_id FROM applications ORDER BY id')).rows;
    const filesByOwner = await listFileOwners();

    const reviewer = users.find((u) => u.role === 'reviewer');
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
        fileOfA: filesByOwner.get(studentA.id)[0],
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
        ['GET', 'users'], ['GET', 'users/all'], ['PUT', `users/${d.studentB.id}/language`], ['PUT', `users/${d.studentB.id}/role`],
        ['GET', 'pte-courses'], ['GET', 'settings/status'], ['PUT', 'settings/toggle'],
        ['GET', 'archive'], ['POST', 'archive/generate'], ['GET', 'archive/x.pdf/download'],
        ['POST', 'refresh-token'], ['GET', 'me'],
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
        if (!canSubmitNow(settings)) {
            skip("A submits an application with B's file", `submissions aren't possible now (${settings.body?.submission?.state || 'closed'}), so the server stops earlier`);
        } else {
            // A's own programme's courses, those A has NOT applied for first: the submit tests must not
            // run into the one-active-application rule (Group 6), which is tested on its own further down
            const appliedByA = new Set((await pool.query(
                "SELECT target_course_code FROM applications WHERE student_id = $1 AND status = ANY($2) AND target_course_code IS NOT NULL",
                [d.studentA.id, ['pending', 'needs_info', 'approved']]
            )).rows.map((r) => r.target_course_code));
            const ownWithCodes = (await pool.query('SELECT id, course_code FROM courses WHERE programme_id = $1 ORDER BY id', [d.studentA.programme_id])).rows;
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

    // Course list: a student only ever sees their own programme's courses
    const courseIdsOf = async (programmeId) => (await pool.query(
        'SELECT id FROM courses WHERE programme_id = $1 ORDER BY id', [programmeId]
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
        const stream = minioClient.listObjects('transcripts', '', true);
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
            'pte_course_names', 'resubmit_count', 'reviewer_note', 'status', 'submitted_at', 'target_course_code', 'target_courses'];
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
        await expect('Reviewer changes a withdrawn application', call('PUT', `applications/${withdrawnOfA}/status`, { token: R, json: { status: 'approved', note: 'x' } }), 409, 'APPLICATION_WITHDRAWN');
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
    const newStudent = (extra) => ({ name: 'Security Check', email: `security-check-${Date.now()}@tr.pte.hu`, password: 'x-Security-Check-1', programme_code: d.programmeCodes[0], ...extra });
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
        await restoreDrafts();
    } catch (err) {
        console.error('Could not put back the drafts of students A and B:', err.message);
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
