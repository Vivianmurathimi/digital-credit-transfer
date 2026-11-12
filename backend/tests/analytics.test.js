/**
 * Analytics (utils/analytics.js, admin round Group 7) against a hand count:
 *
 *   npm test
 *
 * A test semester far in the future with eight applications whose submission and decision times
 * are fixed, so every number below is worked out by hand; each belongs to its own temporary student
 * (@analytics-test.invalid). All deleted afterwards.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { semesterAnalytics } = require('../utils/analytics');

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2097-03-02T09:00:00Z');
const at = (days) => new Date(T0.getTime() + days * DAY);

let semesterId;
let programmes; // [P1, P2]
const created = [];
const students = []; // one temporary student per application (one active application per course and student)
const run = Date.now().toString(36).toUpperCase();

// One application: status, programme, course, decided after `decidedAfter` days by `by`
const add = async ({ status, programme, course, decidedAfter = null, by = null }) => {
    const decided = decidedAfter !== null;
    const neptun = `A${run.slice(-3)}${students.length}`.padEnd(6, '0').slice(0, 6);
    const student = (await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
         VALUES ('Analytics Test', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id`,
        [`analytics-${run}-${students.length}@analytics-test.invalid`, neptun, programme.id]
    )).rows[0];
    students.push(student.id);
    const { rows } = await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id,
             created_at, final_grade, decided_by_role, decided_at)
         VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, $7::timestamptz AT TIME ZONE 'UTC',
                 CASE WHEN $5::varchar = 'approved' THEN 4 END, $8, $9) RETURNING id`,
        [student.id, programme.id, JSON.stringify([{ course_code: course, course_name: `Course ${course}`, credits: 3 }]), course, status, semesterId,
            T0, decided ? by : null, decided ? at(decidedAfter) : null]
    );
    created.push(rows[0].id);
    return rows[0].id;
};
const event = (applicationId, kind, days) => pool.query(
    "INSERT INTO application_events (application_id, kind, actor_role, status, created_at) VALUES ($1, $2, 'reviewer', 'pending', $3)",
    [applicationId, kind, at(days)]
);

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    programmes = (await pool.query('SELECT id, code FROM programmes ORDER BY code LIMIT 2')).rows;
    assert.ok(programmes.length === 2, 'needs two programmes');
    semesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2097-03-01T00:00:00Z', '2097-03-31T21:59:00Z', '2097-04-14T21:59:00Z', '2097-06-30') RETURNING id`,
        [`Analytics test ${Date.now()}`]
    )).rows[0].id;
    const [P1, P2] = programmes;
    // P1
    await add({ status: 'approved', programme: P1, course: 'C1', decidedAfter: 2, by: 'reviewer' });     // 2 days
    const a2 = await add({ status: 'rejected', programme: P1, course: 'C2', decidedAfter: 4, by: 'admin' }); // 4 days, 2 waiting
    await event(a2, 'info_requested', 1);
    await event(a2, 'replied', 3);
    await add({ status: 'rejected', programme: P1, course: 'C1', decidedAfter: 10, by: 'system' });      // left out of the time
    await add({ status: 'pending', programme: P1, course: 'C3' });
    await add({ status: 'withdrawn', programme: P1, course: 'C1' });                                      // not in the top courses
    await add({ status: 'needs_info', programme: P1, course: 'C2' });
    await add({ status: 'approved', programme: P1, course: 'C1', decidedAfter: 0.5, by: 'reviewer' });   // 12 hours
    // P2
    await add({ status: 'approved', programme: P2, course: 'D1', decidedAfter: 1, by: 'reviewer' });     // 1 day
});

after(async () => {
    await pool.query('DELETE FROM applications WHERE id = ANY($1)', [created]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [students]);
    await pool.query('DELETE FROM semesters WHERE id = $1', [semesterId]);
    await pool.end();
});

test('applications by status, overall and per programme', async () => {
    const { status } = await semesterAnalytics(pool, semesterId);
    assert.deepEqual(status.overall, { pending: 1, needs_info: 1, approved: 3, rejected: 2, withdrawn: 1, total: 8 });
    const [p1, p2] = status.byProgramme;
    assert.equal(p1.programme.code, programmes[0].code);
    assert.deepEqual([p1.pending, p1.needs_info, p1.approved, p1.rejected, p1.withdrawn, p1.total], [1, 1, 2, 2, 1, 7]);
    assert.deepEqual([p2.approved, p2.total], [1, 1]);
});

test('time to decision: reviewer and admin decisions, System left out; average and median, with and without waiting', async () => {
    const { turnaround } = await semesterAnalytics(pool, semesterId);
    const [p1, p2] = turnaround.byProgramme;
    // P1: 0.5, 2 and 4 days (the 10-day System rejection is not counted)
    assert.deepEqual([p1.decided, p1.averageDays, p1.medianDays], [3, 2.2, 2]);
    // without waiting: 0.5, 2 and 4 - 2 = 2
    assert.deepEqual([p1.averageDaysWithoutWaiting, p1.medianDaysWithoutWaiting], [1.5, 2]);
    assert.deepEqual([p2.decided, p2.averageDays, p2.medianDays], [1, 1, 1]);
    // all: 0.5, 1, 2, 4 -> average 1.875, median 1.5; without waiting 0.5, 1, 2, 2 -> 1.375, 1.5
    assert.deepEqual([turnaround.overall.decided, turnaround.overall.averageDays, turnaround.overall.medianDays], [4, 1.9, 1.5]);
    assert.deepEqual([turnaround.overall.averageDaysWithoutWaiting, turnaround.overall.medianDaysWithoutWaiting], [1.4, 1.5]);
});

test('a System auto-rejection never changes the time to decision', async () => {
    const before10 = (await semesterAnalytics(pool, semesterId)).turnaround.overall;
    const extra = await add({ status: 'rejected', programme: programmes[0], course: 'C9', decidedAfter: 30, by: 'system' });
    const after10 = (await semesterAnalytics(pool, semesterId)).turnaround.overall;
    assert.deepEqual(after10, before10);
    await pool.query('DELETE FROM applications WHERE id = $1', [extra]);
    created.splice(created.indexOf(extra), 1);
});

test('the most-requested courses: withdrawn left out, auto-rejected counted, ties by programme and code', async () => {
    const { topCourses } = await semesterAnalytics(pool, semesterId);
    const [P1, P2] = programmes;
    // C1: approved, System-rejected, approved (the withdrawn one not); C2: 2; then the two with 1, by programme code
    assert.deepEqual(topCourses.map((c) => [c.programme.code, c.courseCode, c.applications]), [
        [P1.code, 'C1', 3], [P1.code, 'C2', 2], [P1.code, 'C3', 1], [P2.code, 'D1', 1],
    ]);
});

test('an empty semester gives zeros, not errors', async () => {
    const empty = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2096-03-01T00:00:00Z', '2096-03-31T21:59:00Z', '2096-04-14T21:59:00Z', '2096-06-30') RETURNING id`,
        [`Analytics empty ${Date.now()}`]
    )).rows[0].id;
    try {
        const a = await semesterAnalytics(pool, empty);
        assert.equal(a.status.overall.total, 0);
        assert.deepEqual(a.status.byProgramme, []);
        assert.equal(a.turnaround.overall.decided, 0);
        assert.equal(a.turnaround.overall.averageDays, null);
        assert.deepEqual(a.topCourses, []);
    } finally {
        await pool.query('DELETE FROM semesters WHERE id = $1', [empty]);
    }
});
