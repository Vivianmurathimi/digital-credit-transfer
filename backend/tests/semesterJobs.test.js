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
const { getSubmissionState } = require('../utils/semesters');

const jobsModule = '../jobs/applicationJobs';
let { closeEndedSemesters, runApplicationJobs } = require(jobsModule);

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
let students;
let draftBackup;
const created = [];

const recorder = () => {
    const sent = [];
    return { sent, notify: async (studentId, type, data) => { sent.push({ studentId, type, data }); } };
};

const application = async (status, student = students[0]) => {
    const code = `SEMTEST${Date.now().toString(36)}${created.length}`.toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, info_deadline)
         VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN $5::varchar = 'needs_info' THEN $7::timestamptz END) RETURNING id`,
        [student.id, student.programme_id, JSON.stringify([{ course_code: code, course_name: 'Semester test', credits: 1 }]), code, status, semesterId,
            new Date(ENDS_AT.getTime() + 48 * HOUR)]
    );
    created.push(rows[0].id);
    return rows[0].id;
};
const statusOf = async (id) => (await pool.query('SELECT status, reviewer_note, info_deadline FROM applications WHERE id = $1', [id])).rows[0];
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
        `INSERT INTO semesters (name, applications_open_on, applications_close_on, ends_on)
         VALUES ($1, '2099-09-01', '2099-09-30', $2) RETURNING id`,
        [`Semester test ${Date.now()}`, ENDS_ON]
    )).rows[0].id;
});

after(async () => {
    if (created.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [created]);
    if (semesterId) await pool.query('DELETE FROM semesters WHERE id = $1', [semesterId]);
    // The two students' drafts exactly as they were
    await pool.query('DELETE FROM application_drafts WHERE student_id = ANY($1)', [draftStudents()]);
    for (const d of draftBackup) {
        await pool.query('INSERT INTO application_drafts (student_id, version, data, updated_at) VALUES ($1, $2, $3, $4)', [d.student_id, d.version, d.data, d.updated_at]);
    }
    await pool.end();
});

test('the application period in Budapest time, to the second (summer time in September)', async () => {
    const state = async (iso) => (await getSubmissionState(pool, new Date(iso))).state;
    // 1 Sep 00:00 Budapest (UTC+2) = 31 Aug 22:00 UTC
    assert.equal(await state('2099-08-31T21:59:59Z'), 'not_started');
    assert.equal(await state('2099-08-31T22:00:00Z'), 'open');
    // Last 7 days: from 24 Sep 00:00 Budapest
    assert.equal(await state('2099-09-23T21:59:59Z'), 'open');
    assert.equal(await state('2099-09-23T22:00:00Z'), 'last_days');
    // Last day until 30 Sep 23:59:59 Budapest
    assert.equal(await state('2099-09-30T21:59:59Z'), 'last_days');
    assert.equal(await state('2099-09-30T22:00:00Z'), 'period_over');
});

test('the semester ends at midnight Budapest time on the day winter time starts; afterwards: between semesters', async () => {
    const state = async (date) => (await getSubmissionState(pool, date)).state;
    assert.equal(await state(new Date(ENDS_AT.getTime() - SECOND)), 'period_over', 'last second of the semester');
    // With no later semester, after this one there is none current and none coming
    assert.equal(await state(ENDS_AT), 'between_semesters');
    const s = await getSubmissionState(pool, new Date(ENDS_AT.getTime() - SECOND));
    assert.equal(s.semester.endsOn, ENDS_ON);
    assert.equal(s.canSubmit, false);
});

test('at the semester end: unreviewed applications rejected as System, decided ones untouched, old drafts deleted', async () => {
    const pending = await application('pending');
    const waiting = await application('needs_info');
    const approved = await application('approved');
    const only = [pending, waiting, approved];
    const { sent, notify } = recorder();
    await saveDraft(students[0], new Date(ENDS_AT.getTime() - 24 * HOUR)); // saved during the semester
    await saveDraft(students[1], new Date(ENDS_AT.getTime() + HOUR)); // saved after it ended

    assert.equal(await closeEndedSemesters({ now: new Date(ENDS_AT.getTime() - SECOND), notify, only, onlyDraftsOf: draftStudents() }), 0, 'one second before: nothing');
    assert.equal((await statusOf(pending)).status, 'pending');
    assert.ok(await hasDraft(students[0]), 'draft still there before the end');

    const count = await closeEndedSemesters({ now: new Date(ENDS_AT.getTime() + 2 * HOUR), notify, only, onlyDraftsOf: draftStudents() });
    assert.equal(count, 2);
    for (const id of [pending, waiting]) {
        const row = await statusOf(id);
        assert.equal(row.status, 'rejected');
        assert.equal(row.reviewer_note, 'Not reviewed before the semester closed.');
        assert.equal(row.info_deadline, null);
        assert.deepEqual(await historyOf(id), [{ kind: 'auto_rejected', actor_role: 'system', reason_code: 'SEMESTER_ENDED' }]);
    }
    assert.equal((await statusOf(approved)).status, 'approved', 'a decided application is kept as it is');
    assert.equal(sent.length, 2);
    assert.ok(sent.every((e) => e.type === 'statusUpdate' && e.data.reasonCode === 'SEMESTER_ENDED' && e.data.status === 'rejected'));
    assert.equal(await hasDraft(students[0]), false, 'the draft saved during the semester is deleted');
    assert.equal(await hasDraft(students[1]), true, 'a draft saved after the end is kept');
});

test('running again, and again after a restart, changes nothing', async () => {
    const id = await application('pending');
    const only = [id];
    const { sent, notify } = recorder();
    const later = new Date(ENDS_AT.getTime() + 3 * HOUR);
    assert.equal(await closeEndedSemesters({ now: later, notify, only, onlyDraftsOf: draftStudents() }), 1);
    assert.equal(await closeEndedSemesters({ now: later, notify, only, onlyDraftsOf: draftStudents() }), 0, 'second run');

    // A restart: the job module is loaded fresh; everything it needs is in the database
    delete require.cache[require.resolve(jobsModule)];
    ({ closeEndedSemesters, runApplicationJobs } = require(jobsModule));
    const results = await runApplicationJobs({ now: new Date(ENDS_AT.getTime() + 24 * HOUR), notify, only, onlyDraftsOf: draftStudents() });
    assert.deepEqual(results, { 'semester end': 0, 'deadline reminders': 0, 'overdue information requests': 0 });
    assert.equal((await historyOf(id)).length, 1, 'one history entry');
    assert.equal(sent.length, 1, 'one email');
});

test('two runs at the same moment close each application once', async () => {
    const ids = [await application('pending'), await application('needs_info'), await application('pending', students[1])];
    const first = recorder();
    const second = recorder();
    const now = new Date(ENDS_AT.getTime() + 4 * HOUR);
    await Promise.all([
        closeEndedSemesters({ now, notify: first.notify, only: ids, onlyDraftsOf: [] }),
        closeEndedSemesters({ now, notify: second.notify, only: ids, onlyDraftsOf: [] }),
    ]);
    for (const id of ids) assert.equal((await historyOf(id)).length, 1);
    assert.equal(first.sent.length + second.sent.length, ids.length);
});
