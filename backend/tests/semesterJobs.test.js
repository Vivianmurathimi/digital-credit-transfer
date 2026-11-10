/**
 * Tests for semesters (Group 3) with a fake clock:
 *
 *   npm test
 *
 * Uses the database from backend/.env (run "npm run migrate" first). It adds a test semester far in
 * the future (2099, ending on the day winter time starts), its own test applications, and changes
 * the drafts of two test students; at the end it deletes what it added and puts the drafts back.
 * Every job run is limited to the test's own applications and these two students' drafts
 * (`only`, `onlyDraftsOf`), so real data is never touched, and no email is sent.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { periodFor } = require('../utils/applicationPeriod');

const jobsModule = '../jobs/applicationJobs';
let { runApplicationJobs } = require(jobsModule);
const { remindUnsentDrafts } = require('../jobs/applicationJobs');
const { closePreview, closeSemester } = require('../utils/semesterClose');

// The last Sunday of October 2099: winter time starts, Budapest goes from UTC+2 to UTC+1
const lastSundayOfOctober = (year) => {
    const day = new Date(Date.UTC(year, 9, 31));
    day.setUTCDate(31 - day.getUTCDay());
    return day.toISOString().slice(0, 10);
};
const ENDS_ON = lastSundayOfOctober(2099);
// The first moment after the semester: 00:00 on the next day, already winter time (UTC+1)
const ENDS_AT = new Date(`${ENDS_ON}T23:00:00Z`);
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

let semesterId;
let raceSemesterId; // a second test semester for two closes at once
let students;
let admin;
let draftBackup;
const created = [];

const recorder = () => {
    const sent = [];
    return { sent, notify: async (studentId, type, data) => { sent.push({ studentId, type, data }); } };
};

const application = async (status, student = students[0], semester = semesterId) => {
    const code = `SEMTEST${Date.now().toString(36)}${created.length}`.toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, info_deadline, final_grade)
         VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN $5::varchar = 'needs_info' THEN $7::timestamptz END,
                 CASE WHEN $5::varchar = 'approved' THEN 4 END) RETURNING id`,
        [student.id, student.programme_id, JSON.stringify([{ course_code: code, course_name: 'Semester test', credits: 1 }]), code, status, semester,
            new Date(ENDS_AT.getTime() + 48 * HOUR)]
    );
    created.push(rows[0].id);
    return rows[0].id;
};
const statusOf = async (id) => (await pool.query(
    'SELECT status, reviewer_note, info_deadline, decided_by, decided_by_role, decision_rationale FROM applications WHERE id = $1', [id])).rows[0];
const historyOf = async (id) => (await pool.query("SELECT kind, actor_role, reason_code FROM application_events WHERE application_id = $1 AND kind = 'auto_rejected'", [id])).rows;
const draftStudents = () => students.map((s) => s.id);
const saveDraft = (student, updatedAt) => pool.query(
    `INSERT INTO application_drafts (student_id, version, data, updated_at) VALUES ($1, 1, '{"note":"semester test"}', $2)
     ON CONFLICT (student_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [student.id, updatedAt]
);
const hasDraft = async (student) => (await pool.query('SELECT 1 FROM application_drafts WHERE student_id = $1', [student.id])).rows.length > 0;

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    students = (await pool.query("SELECT id, programme_id FROM users WHERE role = 'student' AND programme_id IS NOT NULL ORDER BY id LIMIT 2")).rows;
    assert.equal(students.length, 2, 'needs two students with a programme (npm run seed:dev)');
    draftBackup = (await pool.query('SELECT * FROM application_drafts WHERE student_id = ANY($1)', [draftStudents()])).rows;
    semesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, end_date)
         VALUES ($1, 'setup', '2099-09-01'::timestamp AT TIME ZONE 'Europe/Budapest',
                 ('2099-09-30'::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', $2) RETURNING id`,
        [`Semester test ${Date.now()}`, ENDS_ON]
    )).rows[0].id;
    raceSemesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, end_date)
         VALUES ($1, 'setup', '2098-09-01'::timestamp AT TIME ZONE 'Europe/Budapest', ('2098-09-30'::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', '2098-10-31')
         RETURNING id`,
        [`Semester race test ${Date.now()}`]
    )).rows[0].id;
    admin = (await pool.query("SELECT id FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1")).rows[0];
    assert.ok(admin, 'needs a superadmin (npm run seed:dev)');
});

after(async () => {
    if (created.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [created]);
    await pool.query('DELETE FROM late_access WHERE semester_id = ANY($1)', [[semesterId, raceSemesterId]]);
    await pool.query('DELETE FROM semesters WHERE id = ANY($1)', [[semesterId, raceSemesterId]]);
    // The two students' drafts exactly as they were
    await pool.query('DELETE FROM application_drafts WHERE student_id = ANY($1)', [draftStudents()]);
    for (const d of draftBackup) {
        await pool.query('INSERT INTO application_drafts (student_id, version, data, updated_at) VALUES ($1, $2, $3, $4)', [d.student_id, d.version, d.data, d.updated_at]);
    }
    await pool.end();
});

test('the application period in Budapest time, to the second (summer time in September)', async () => {
    // Judged as the active semester (only the active one counts, admin round Group 4)
    const state = async (iso) => (await periodFor(pool, { now: new Date(iso), semesterId })).state;
    // Opens 1 Sep 00:00 Budapest (UTC+2) = 31 Aug 22:00 UTC
    assert.equal(await state('2099-08-31T21:59:59Z'), 'not_started');
    assert.equal(await state('2099-08-31T22:00:00Z'), 'open');
    // Last days (default 3, admin round Group 5): from 27 Sep 23:59 Budapest, 3 days before closing
    assert.equal(await state('2099-09-27T21:58:59Z'), 'open');
    assert.equal(await state('2099-09-27T21:59:00Z'), 'last_days');
    // Closes 30 Sep 23:59 Budapest (a closing day becomes 23:59, migration 016)
    assert.equal(await state('2099-09-30T21:58:59Z'), 'last_days');
    assert.equal(await state('2099-09-30T21:59:00Z'), 'period_over');
});

test('a semester in setup is never open, whatever its dates (the admin activates it)', async () => {
    const s = await periodFor(pool, { now: new Date('2099-09-10T10:00:00Z') });
    assert.notEqual(s.semester?.id === semesterId && s.canSubmit, true, 'the setup semester does not take applications');
});

test('the semester ends at midnight Budapest time on the day winter time starts', async () => {
    const state = async (date) => (await periodFor(pool, { now: date, semesterId })).state;
    assert.equal(await state(new Date(ENDS_AT.getTime() - SECOND)), 'period_over', 'last second of the semester');
    assert.equal(await state(ENDS_AT), 'period_over', 'after its end it never opens again');
    const s = await periodFor(pool, { now: new Date(ENDS_AT.getTime() - SECOND), semesterId });
    assert.equal(s.semester.endsOn, ENDS_ON);
    assert.equal(s.canSubmit, false);
});

test('the end date alone rejects nothing: the job has no semester-end step any more (admin round Group 6)', async () => {
    const id = await application('pending');
    const { sent, notify } = recorder();
    const results = await runApplicationJobs({ now: new Date(ENDS_AT.getTime() + 24 * HOUR), notify, remind: async () => {}, only: [id], onlyDraftsOf: draftStudents() });
    assert.ok(!('semester end' in results), 'no semester-end step');
    assert.equal((await statusOf(id)).status, 'pending', 'still pending after the last day, until the admin closes');
    assert.equal(sent.length, 0);
});

test('closing: refused before the end and with a wrong name; the preview counts are exactly what is rejected', async () => {
    const pending = await application('pending');
    const waiting = await application('needs_info');
    const approved = await application('approved');
    const { sent, notify } = recorder();
    await saveDraft(students[0], new Date(ENDS_AT.getTime() - 24 * HOUR));
    await saveDraft(students[1], new Date(ENDS_AT.getTime() - 2 * HOUR));
    const name = (await pool.query('SELECT name FROM semesters WHERE id = $1', [semesterId])).rows[0].name;
    const base = { semesterId, adminId: admin.id, notify, onlyDraftsOf: draftStudents(), book: false, requireActive: false };

    const early = await closeSemester({ ...base, confirmName: name, now: new Date(ENDS_AT.getTime() - SECOND) });
    assert.equal(early.error?.[1], 'SEMESTER_NOT_ENDED', 'not before the end date');
    const wrong = await closeSemester({ ...base, confirmName: `${name} x`, now: ENDS_AT });
    assert.equal(wrong.error?.[1], 'CONFIRM_NAME_MISMATCH');
    assert.equal((await statusOf(pending)).status, 'pending', 'nothing changed by the refused closes');

    const late = (await pool.query(
        "INSERT INTO late_access (email, semester_id, deadline) VALUES ('close.test@semester-test.invalid', $1, $2) RETURNING id",
        [semesterId, new Date(ENDS_AT.getTime() + 48 * HOUR)]
    )).rows[0].id;
    const now = new Date(ENDS_AT.getTime() + 2 * HOUR);
    const preview = await closePreview(pool, semesterId, { now, onlyDraftsOf: draftStudents() });
    const ownPending = (await pool.query("SELECT count(*)::int AS n FROM applications WHERE semester_id = $1 AND status = 'pending'", [semesterId])).rows[0].n;
    const ownWaiting = (await pool.query("SELECT count(*)::int AS n FROM applications WHERE semester_id = $1 AND status = 'needs_info'", [semesterId])).rows[0].n;
    assert.deepEqual([preview.pending, preview.needsInfo, preview.drafts, preview.lateAccess, preview.ended], [ownPending, ownWaiting, 2, 1, true]);

    const closed = await closeSemester({ ...base, confirmName: ` ${name} `, now });
    assert.equal(closed.error, undefined);
    assert.equal(closed.summary.pending, preview.pending, 'pending: preview = rejected');
    assert.equal(closed.summary.needsInfo, preview.needsInfo, 'needs info: preview = rejected');
    assert.equal(closed.summary.rejected, preview.pending + preview.needsInfo);
    assert.equal(closed.summary.drafts, 2);
    assert.equal(closed.summary.lateAccess, 1);
    for (const id of [pending, waiting]) {
        const row = await statusOf(id);
        assert.equal(row.status, 'rejected');
        assert.equal(row.reviewer_note, null, 'no English text stored (reviewer Group 7)');
        assert.equal(row.info_deadline, null);
        assert.deepEqual([row.decided_by, row.decided_by_role, row.decision_rationale], [null, 'system', null]);
        assert.deepEqual(await historyOf(id), [{ kind: 'auto_rejected', actor_role: 'system', reason_code: 'SEMESTER_ENDED' }]);
    }
    assert.equal((await statusOf(approved)).status, 'approved', 'a decided application is kept as it is');
    assert.equal(sent.length, closed.summary.rejected, 'one email per rejected application, after the commit');
    assert.ok(sent.every((e) => e.type === 'statusUpdate' && e.data.reasonCode === 'SEMESTER_ENDED' && e.data.status === 'rejected'));
    assert.equal(await hasDraft(students[0]), false, 'unsent drafts are deleted');
    assert.ok((await pool.query('SELECT revoked_at FROM late_access WHERE id = $1', [late])).rows[0].revoked_at, 'late access ended');
    const semester = (await pool.query('SELECT status, closed_at, closed_by FROM semesters WHERE id = $1', [semesterId])).rows[0];
    assert.deepEqual([semester.status, semester.closed_at.toISOString(), semester.closed_by], ['closed', now.toISOString(), admin.id]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM applications WHERE id = ANY($1)', [[pending, waiting, approved]])).rows[0].n, 3, 'nothing deleted');

    const again = await closeSemester({ ...base, confirmName: name, now });
    assert.equal(again.error?.[1], 'ALREADY_CLOSED', 'a second close changes nothing');
    assert.equal(sent.length, closed.summary.rejected, 'no more emails');
});

test('the closed semester is read-only: the job never touches it again', async () => {
    const { sent, notify } = recorder();
    const results = await runApplicationJobs({ now: new Date(ENDS_AT.getTime() + 72 * HOUR), notify, remind: async () => {}, only: created, onlyDraftsOf: draftStudents() });
    assert.ok(Object.values(results).every((n) => n === 0), JSON.stringify(results));
    assert.equal(sent.length, 0);
});

test('two closes at the same moment: one closes, the other is refused, each application rejected once', async () => {
    const ids = [await application('pending', students[0], raceSemesterId), await application('needs_info', students[1], raceSemesterId)];
    const name = (await pool.query('SELECT name FROM semesters WHERE id = $1', [raceSemesterId])).rows[0].name;
    const first = recorder();
    const second = recorder();
    const now = new Date('2098-11-02T10:00:00Z');
    const base = { semesterId: raceSemesterId, adminId: admin.id, confirmName: name, now, onlyDraftsOf: [], book: false, requireActive: false };
    const results = await Promise.all([closeSemester({ ...base, notify: first.notify }), closeSemester({ ...base, notify: second.notify })]);
    assert.equal(results.filter((r) => !r.error).length, 1, 'one close');
    assert.equal(results.find((r) => r.error)?.error[1], 'ALREADY_CLOSED');
    for (const id of ids) assert.equal((await historyOf(id)).length, 1);
    assert.equal(first.sent.length + second.sent.length, ids.length);
});

test('unsent draft: one email when the last-days warning starts, once per student and semester', async (t) => {
    const active = (await pool.query("SELECT id, last_days_from, closes_at FROM semester_bounds WHERE status = 'active'")).rows[0];
    if (!active) { t.skip('no active semester in this database'); return; }
    await saveDraft(students[0], new Date());
    await pool.query('DELETE FROM draft_reminders WHERE semester_id = $1 AND student_id = $2', [active.id, students[0].id]);
    const { sent, notify } = recorder();
    const only = [students[0].id];
    try {
        assert.equal(await remindUnsentDrafts({ now: new Date(active.last_days_from.getTime() - SECOND), notify, onlyDraftsOf: only }), 0, 'not before the last days');
        assert.equal(await remindUnsentDrafts({ now: new Date(active.last_days_from.getTime() + SECOND), notify, onlyDraftsOf: only }), 1);
        assert.equal(await remindUnsentDrafts({ now: new Date(active.last_days_from.getTime() + HOUR), notify, onlyDraftsOf: only }), 0, 'never twice');
        assert.equal(sent.length, 1);
        assert.equal(sent[0].type, 'draftReminder');
        assert.equal(sent[0].data.deadline.toISOString(), active.closes_at.toISOString(), 'with the closing time');
    } finally {
        await pool.query('DELETE FROM draft_reminders WHERE semester_id = $1 AND student_id = $2', [active.id, students[0].id]);
    }
});
