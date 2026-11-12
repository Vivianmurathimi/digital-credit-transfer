/**
 * Tests for semesters (Group 3; round 2 Group 1: the review period and the new close) with a fake clock:
 *
 *   npm test
 *
 * Uses the database from backend/.env (run "npm run migrate" first). It adds test semesters far in
 * the future (2099, its last day the day winter time starts; and 2098), its own test applications,
 * and changes the drafts of two test students; at the end it deletes what it added and puts the
 * drafts back.
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
// The first moment after the semester's last day (a label only now): 00:00 the next day, winter time (UTC+1)
const ENDS_AT = new Date(`${ENDS_ON}T23:00:00Z`);
// Applications close 30 Sep 2099 23:59 Budapest (UTC+2); the review deadline is 14 Oct 23:59
const CLOSES_AT = new Date('2099-09-30T21:59:00Z');
const REVIEW_AT = new Date('2099-10-14T21:59:00Z');
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

let semesterId;
let raceSemesterId; // a second test semester for two closes at once
let students;
let admin;
let draftBackup;
let laterSemesterId; // a semester whose application period is still to come: drafts belong to it
const created = [];

const recorder = () => {
    const sent = [];
    return { sent, notify: async (studentId, type, data) => { sent.push({ studentId, type, data }); } };
};

const application = async (status, student = students[0], semester = semesterId) => {
    const code = `SEMTEST${Date.now().toString(36)}${created.length}`.toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, info_deadline, final_grade, committee_state)
         VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN $5::varchar = 'needs_info' THEN $7::timestamptz END,
                 CASE WHEN $5::varchar = 'approved' THEN 4 END, CASE WHEN ($5::varchar)::varchar IN ('approved', 'rejected') THEN 'before_committee' END) RETURNING id`,
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
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2099-09-01'::timestamp AT TIME ZONE 'Europe/Budapest', $3, $4, $2) RETURNING id`,
        [`Semester test ${Date.now()}`, ENDS_ON, CLOSES_AT, REVIEW_AT]
    )).rows[0].id;
    raceSemesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2098-09-01'::timestamp AT TIME ZONE 'Europe/Budapest', ('2098-09-30'::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
                 ('2098-10-14'::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', '2098-10-31')
         RETURNING id`,
        [`Semester race test ${Date.now()}`]
    )).rows[0].id;
    laterSemesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2099-12-01T10:00:00Z', '2099-12-20T10:00:00Z', '2100-01-05T10:00:00Z', '2100-01-31') RETURNING id`,
        [`Semester later test ${Date.now()}`]
    )).rows[0].id;
    admin = (await pool.query("SELECT id FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1")).rows[0];
    assert.ok(admin, 'needs a superadmin (npm run seed:dev)');
});

after(async () => {
    if (created.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [created]);
    await pool.query('DELETE FROM late_access WHERE semester_id = ANY($1)', [[semesterId, raceSemesterId, laterSemesterId]]);
    await pool.query('DELETE FROM semesters WHERE id = ANY($1)', [[semesterId, raceSemesterId, laterSemesterId]]);
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

test("the semester's last day is a label: the period never depends on it", async () => {
    const state = async (date) => (await periodFor(pool, { now: date, semesterId })).state;
    assert.equal(await state(new Date(ENDS_AT.getTime() - SECOND)), 'period_over', 'its period closed on 30 Sep');
    assert.equal(await state(ENDS_AT), 'period_over', 'after its last day nothing changes');
    const s = await periodFor(pool, { now: new Date(ENDS_AT.getTime() - SECOND), semesterId });
    assert.equal(s.semester.endsOn, ENDS_ON, 'still shown, as a label');
    assert.equal(new Date(s.semester.reviewEndsAt).toISOString(), REVIEW_AT.toISOString());
    assert.equal(s.canSubmit, false);
});

test('neither the last day nor the review deadline rejects anything: no automatic rejection', async () => {
    const id = await application('pending');
    const { sent, notify } = recorder();
    const results = await runApplicationJobs({ now: new Date(ENDS_AT.getTime() + 24 * HOUR), notify, remind: async () => {}, alert: async () => {}, only: [id], onlyDraftsOf: draftStudents() });
    assert.ok(!('semester end' in results), 'no semester-end step');
    assert.equal((await statusOf(id)).status, 'pending', 'still pending after the review deadline and the last day');
    assert.equal(sent.length, 0);
});

test('closing: refused while the period is open, while late access runs and while anything is undecided; allowed before the review deadline; rejects nobody', async () => {
    const pending = await application('pending');
    const waiting = await application('needs_info');
    const approved = await application('approved');
    await saveDraft(students[0], new Date(CLOSES_AT.getTime() - 24 * HOUR));
    await saveDraft(students[1], new Date(CLOSES_AT.getTime() - 2 * HOUR));
    const name = (await pool.query('SELECT name FROM semesters WHERE id = $1', [semesterId])).rows[0].name;
    const base = { semesterId, adminId: admin.id, onlyDraftsOf: draftStudents(), book: false, requireActive: false };

    const early = await closeSemester({ ...base, confirmName: name, now: new Date(CLOSES_AT.getTime() - SECOND) });
    assert.equal(early.error?.[1], 'PERIOD_STILL_OPEN', 'not while the application period runs');
    const wrong = await closeSemester({ ...base, confirmName: `${name} x`, now: CLOSES_AT });
    assert.equal(wrong.error?.[1], 'CONFIRM_NAME_MISMATCH');

    const late = (await pool.query(
        "INSERT INTO late_access (email, semester_id, deadline) VALUES ('close.test@semester-test.invalid', $1, $2) RETURNING id",
        [semesterId, new Date(CLOSES_AT.getTime() + 48 * HOUR)]
    )).rows[0].id;
    const duringLate = new Date(CLOSES_AT.getTime() + 2 * HOUR);
    const preview = await closePreview(pool, semesterId, { now: duringLate, onlyDraftsOf: draftStudents(), requireActive: false });
    assert.deepEqual(preview.blockers, ['LATE_ACCESS_ACTIVE', 'UNDECIDED_APPLICATIONS'], 'the preview lists what blocks it');
    assert.equal(preview.canClose, false);
    const programme = preview.undecidedByProgramme.find((p) => p.pending >= 1 && p.needs_info >= 1);
    assert.ok(programme, 'the undecided ones per programme');
    assert.equal((await closeSemester({ ...base, confirmName: name, now: duringLate })).error?.[1], 'LATE_ACCESS_ACTIVE', 'refused in the order the preview lists');
    // After the late access deadline: the undecided applications still block it
    const now = new Date(CLOSES_AT.getTime() + 72 * HOUR);
    assert.equal((await closeSemester({ ...base, confirmName: name, now })).error?.[1], 'UNDECIDED_APPLICATIONS');
    for (const id of [pending, waiting]) assert.notEqual((await statusOf(id)).status, 'rejected', 'nothing rejected by the refused closes');
    // Decided (here withdrawn): nothing blocks it any more
    // (the earlier test's pending application of this semester too)
    await pool.query("UPDATE applications SET status = 'withdrawn', info_deadline = NULL WHERE semester_id = $1 AND status IN ('pending', 'needs_info')", [semesterId]);
    assert.ok(now < REVIEW_AT, 'before the review deadline');
    const ready = await closePreview(pool, semesterId, { now, onlyDraftsOf: draftStudents(), requireActive: false });
    assert.deepEqual([ready.canClose, ready.blockers, ready.reviewPassed], [true, [], false]);
    // A later application period is still to come: the drafts belong to it and stay
    assert.deepEqual([ready.drafts, ready.draftsKept], [0, 2]);
    const closed = await closeSemester({ ...base, confirmName: ` ${name} `, now });
    assert.equal(closed.error, undefined);
    assert.equal(closed.summary.rejected, undefined, 'nobody is rejected by a close any more');
    assert.deepEqual([closed.summary.drafts, closed.summary.draftsKept, closed.summary.lateAccess], [0, true, 1], 'drafts kept, the expired late access marked ended');
    assert.equal(await hasDraft(students[0]), true);
    assert.equal((await statusOf(approved)).status, 'approved', 'a decided application is kept as it is');
    assert.deepEqual(await historyOf(pending), [], 'no System rejection');
    assert.ok((await pool.query('SELECT revoked_at FROM late_access WHERE id = $1', [late])).rows[0].revoked_at, 'late access ended');
    const semester = (await pool.query('SELECT status, closed_at, closed_by FROM semesters WHERE id = $1', [semesterId])).rows[0];
    assert.deepEqual([semester.status, semester.closed_at.toISOString(), semester.closed_by], ['closed', now.toISOString(), admin.id]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM applications WHERE id = ANY($1)', [[pending, waiting, approved]])).rows[0].n, 3, 'nothing deleted');

    const again = await closeSemester({ ...base, confirmName: name, now });
    assert.equal(again.error?.[1], 'ALREADY_CLOSED', 'a second close changes nothing');
});

test('the closed semester is read-only: the job never touches it again', async () => {
    const { sent, notify } = recorder();
    const results = await runApplicationJobs({ now: new Date(ENDS_AT.getTime() + 72 * HOUR), notify, remind: async () => {}, only: created, onlyDraftsOf: draftStudents() });
    assert.ok(Object.values(results).every((n) => n === 0), JSON.stringify(results));
    assert.equal(sent.length, 0);
});

test('two closes at the same moment: one closes, the other is refused; with no period to come the drafts go', async () => {
    const ids = [await application('approved', students[0], raceSemesterId), await application('withdrawn', students[1], raceSemesterId)];
    const name = (await pool.query('SELECT name FROM semesters WHERE id = $1', [raceSemesterId])).rows[0].name;
    // A moment after every test semester's application period: the drafts belong to no coming period
    const now = new Date('2101-06-01T10:00:00Z');
    await saveDraft(students[0], new Date());
    const base = { semesterId: raceSemesterId, adminId: admin.id, confirmName: name, now, onlyDraftsOf: [students[0].id], book: false, requireActive: false };
    const results = await Promise.all([closeSemester(base), closeSemester(base)]);
    assert.equal(results.filter((r) => !r.error).length, 1, 'one close');
    assert.equal(results.find((r) => r.error)?.error[1], 'ALREADY_CLOSED');
    assert.equal(results.find((r) => !r.error).summary.drafts, 1, 'the unsent draft deleted');
    assert.equal(await hasDraft(students[0]), false);
    for (const id of ids) assert.deepEqual(await historyOf(id), [], 'nobody rejected');
});

test('unsent draft: one email when the last-days warning starts, once per student and semester', async (t) => {
    // A real semester in progress (not another test file's, which may come and go meanwhile)
    const active = (await pool.query("SELECT id, last_days_from, closes_at FROM semester_bounds WHERE status = 'active' AND name NOT ILIKE '%test%' ORDER BY id LIMIT 1")).rows[0];
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
