/**
 * Tests for the reviewer reminders before the semester ends and the jobs lock (reviewer Group 7),
 * with a fake clock:
 *
 *   npm test
 *
 * Uses the database from backend/.env (run "npm run migrate" first). It adds two test semesters far
 * in the future (2094) and its own test applications in a programme that has an active reviewer, and
 * deletes them at the end (the reminders go with their semester). Every run is limited to the
 * test's own applications (`only`), and no email is sent (a fake `remind` records them).
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { remindReviewersBeforeSemesterEnd, withJobsLock, JOBS_LOCK_KEY } = require('../jobs/applicationJobs');

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;

// Semester A ends in summer time (UTC+2), semester B in winter time (UTC+1)
const SEMESTERS = {
    A: { opens: '2094-02-01', closes: '2094-02-28', endsOn: '2094-06-30', weekBefore: '2094-06-23T22:00:00Z', lastDay: '2094-06-29T22:00:00Z', end: '2094-06-30T22:00:00Z' },
    B: { opens: '2094-09-01', closes: '2094-09-30', endsOn: '2094-12-20', weekBefore: '2094-12-13T23:00:00Z', lastDay: '2094-12-19T23:00:00Z', end: '2094-12-20T23:00:00Z' },
};
const moment = (iso, offsetMs = 0) => new Date(new Date(iso).getTime() + offsetMs);

let student;
const semesterIds = {};
const created = [];

const recorder = () => {
    const sent = [];
    return { sent, remind: async (reminder) => { sent.push(reminder); } };
};

const application = async (semester, status) => {
    const code = `REMTEST${Date.now().toString(36)}${created.length}`.toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, info_deadline, final_grade)
         VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN $5::varchar = 'needs_info' THEN $7::timestamptz END,
                 CASE WHEN $5::varchar = 'approved' THEN 4 END) RETURNING id`,
        [student.id, student.programme_id, JSON.stringify([{ course_code: code, course_name: 'Reminder test', credits: 1 }]), code, status,
            semesterIds[semester], moment(SEMESTERS[semester].end, 10 * DAY)]
    );
    created.push(rows[0].id);
    return rows[0].id;
};
const remindersOf = async (semester) => (await pool.query(
    'SELECT kind, pending_count, needs_info_count, reviewer_id FROM reviewer_reminders WHERE semester_id = $1 ORDER BY id', [semesterIds[semester]]
)).rows;

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    student = (await pool.query(
        `SELECT s.id, s.programme_id, r.id AS reviewer_id
         FROM users s
         JOIN staff_programmes sp ON sp.programme_id = s.programme_id AND sp.role = 'main' AND sp.ended_at IS NULL
         JOIN users r ON r.id = sp.user_id AND r.deactivated_at IS NULL
         WHERE s.role = 'student' ORDER BY s.id LIMIT 1`
    )).rows[0];
    assert.ok(student, 'needs a student whose programme has an active reviewer (npm run seed:dev)');
    for (const [key, s] of Object.entries(SEMESTERS)) {
        semesterIds[key] = (await pool.query(
            `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, end_date)
             VALUES ($1, 'setup', $2::date::timestamp AT TIME ZONE 'Europe/Budapest', ($3::date::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', $4::date)
             RETURNING id`,
            [`Reminder test ${key} ${Date.now()}`, s.opens, s.closes, s.endsOn]
        )).rows[0].id;
    }
});

after(async () => {
    if (created.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [created]);
    // Deleting the semesters also deletes their reminders
    await pool.query('DELETE FROM semesters WHERE id = ANY($1)', [Object.values(semesterIds)]);
    await pool.end();
});

test('7 days before and on the last day: one reminder each, with both numbers, never twice', async () => {
    const s = SEMESTERS.A;
    const only = [await application('A', 'pending'), await application('A', 'pending'), await application('A', 'needs_info'), await application('A', 'approved')];
    const { sent, remind } = recorder();
    const runAt = (when) => remindReviewersBeforeSemesterEnd({ now: when, remind, only });

    assert.equal(await runAt(moment(s.weekBefore, -SECOND)), 0, 'one second before the 7-day mark: nothing');
    assert.equal(await runAt(moment(s.weekBefore)), 1, 'at 00:00 Budapest time, 7 days before the end');
    assert.deepEqual(
        { kind: sent[0].kind, pending: sent[0].pending_count, needsInfo: sent[0].needs_info_count, reviewer: sent[0].reviewer_id, endsOn: sent[0].ends_on },
        { kind: '7_days', pending: 2, needsInfo: 1, reviewer: student.reviewer_id, endsOn: s.endsOn },
        'the approved application is not counted'
    );
    assert.ok(sent[0].reviewer_email && sent[0].programme_en, 'the email has an address and the programme name');

    assert.equal(await runAt(moment(s.weekBefore, 2 * DAY)), 0, 'two days later: already sent');
    assert.equal(await runAt(moment(s.lastDay, -SECOND)), 0, 'just before the last day');
    assert.equal(await runAt(moment(s.lastDay)), 1, 'at 00:00 Budapest time on the last day');
    assert.equal(sent[1].kind, '1_day');
    assert.equal(await runAt(moment(s.lastDay, 12 * HOUR)), 0, 'later that day: already sent');
    assert.equal(await runAt(moment(s.end)), 0, 'the semester has ended: no reminder any more');

    assert.equal(sent.length, 2);
    assert.deepEqual((await remindersOf('A')).map((r) => r.kind), ['7_days', '1_day'], 'both recorded once');
});

test('nothing undecided: nothing sent or recorded; a server that was off all week sends only the last-day reminder, once', async () => {
    const s = SEMESTERS.B;
    const approved = await application('B', 'approved');
    const { sent, remind } = recorder();

    assert.equal(await remindReviewersBeforeSemesterEnd({ now: moment(s.weekBefore, HOUR), remind, only: [approved] }), 0);
    assert.deepEqual(await remindersOf('B'), [], 'nothing recorded, so a reminder can still go out later');

    // A new application arrives; the server is off for the rest of the week and starts on the last day,
    // as two processes at the same moment
    const pending = await application('B', 'pending');
    const second = recorder();
    const now = moment(s.lastDay, HOUR);
    await Promise.all([
        remindReviewersBeforeSemesterEnd({ now, remind, only: [approved, pending] }),
        remindReviewersBeforeSemesterEnd({ now, remind: second.remind, only: [approved, pending] }),
    ]);
    const all = [...sent, ...second.sent];
    assert.equal(all.length, 1, 'one email in total');
    assert.equal(all[0].kind, '1_day', 'the stale 7-day reminder is not sent late');
    assert.deepEqual((await remindersOf('B')).map((r) => [r.kind, r.pending_count, r.needs_info_count]), [['1_day', 1, 0]]);
});

test('a failed reminder email is logged and never undoes the record', async () => {
    // Semester B's 7-day reminder was never recorded (test above): this run records it, its email fails
    const only = created;
    const failing = async () => { throw new Error('SMTP down (test)'); };
    assert.equal(await remindReviewersBeforeSemesterEnd({ now: moment(SEMESTERS.B.weekBefore, 2 * HOUR), remind: failing, only }), 1);
    assert.deepEqual((await remindersOf('B')).map((r) => r.kind).sort(), ['1_day', '7_days'], 'recorded although the email failed');
    const { sent, remind } = recorder();
    assert.equal(await remindReviewersBeforeSemesterEnd({ now: moment(SEMESTERS.B.weekBefore, 3 * HOUR), remind, only }), 0);
    assert.equal(sent.length, 0, 'never sent twice');
});

test('the jobs lock: while another process holds it, a run skips its turn', async () => {
    const other = await pool.connect();
    try {
        await other.query('SELECT pg_advisory_lock($1)', [JOBS_LOCK_KEY]); // waits if a backend is running its jobs now
        let ran = false;
        const blocked = await withJobsLock(async () => { ran = true; });
        assert.deepEqual(blocked, { skipped: true });
        assert.equal(ran, false, 'the work was not started');
    } finally {
        await other.query('SELECT pg_advisory_unlock($1)', [JOBS_LOCK_KEY]);
        other.release();
    }
    // Free again: the work runs and its result comes back (retried in case a real backend runs its jobs right now)
    let run;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        run = await withJobsLock(async () => 'done');
        if (!run.skipped) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.deepEqual(run, { skipped: false, result: 'done' });
    // And the lock was given back (a lock belongs to one connection: checked and released on the same one)
    const client = await pool.connect();
    try {
        let got = false;
        for (let attempt = 0; attempt < 10 && !got; attempt += 1) {
            got = (await client.query('SELECT pg_try_advisory_lock($1) AS got', [JOBS_LOCK_KEY])).rows[0].got;
            if (!got) await new Promise((resolve) => setTimeout(resolve, 300));
        }
        assert.equal(got, true);
        await client.query('SELECT pg_advisory_unlock($1)', [JOBS_LOCK_KEY]);
    } finally {
        client.release();
    }
});
