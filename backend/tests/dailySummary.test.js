/**
 * The reviewers' daily summary and the review-deadline reminders' recipients (round 2 Group 1
 * Part E) with a fake clock:
 *
 *   npm test
 *
 * Builds its own programme (code ZSUM…) with a main reviewer, an assisting extra reviewer and a
 * standby one, a student, applications and their history at fixed moments in 2091, and a semester in
 * progress in 2091; every step is limited to these reviewers or applications. All deleted afterwards.
 * No email is sent (a fake `summarize` / `remind` records them).
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { sendDailySummaries, remindReviewersBeforeReviewDeadline, DAILY_SUMMARY_HOUR } = require('../jobs/applicationJobs');

const run = Date.now().toString(36).toUpperCase();
const at = (iso) => new Date(iso);
let programmeId;
let semesterId;
let main;
let assisting;
let standby;
let student;
const apps = [];

const recorder = () => {
    const sent = [];
    return { sent, summarize: async (summary) => { sent.push(summary); } };
};
const summaries = (now, summarize) => sendDailySummaries({ now, summarize, onlyReviewers: [main.id, assisting.id, standby.id] });

// An application of the test student with one history entry (submitted, or a reply) at a fixed moment
const application = async (n, { status = 'pending', semester = null } = {}) => {
    const code = `ZSUM${run}${n}`.slice(0, 20);
    const id = (await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, committee_state)
         VALUES ($1, $2, '[]', $3, $4, $5::varchar, $6, CASE WHEN ($5::varchar)::varchar IN ('approved', 'rejected') THEN 'before_committee' END) RETURNING id`,
        [student.id, programmeId, JSON.stringify([{ course_code: code, course_name: `Summary course ${n}` }]), code, status, semester]
    )).rows[0].id;
    apps.push(id);
    return id;
};
const event = (applicationId, kind, iso) => pool.query(
    "INSERT INTO application_events (application_id, kind, actor_role, status, created_at) VALUES ($1, $2, 'student', 'pending', $3)",
    [applicationId, kind, at(iso)]
);

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    programmeId = (await pool.query(
        "INSERT INTO programmes (code, name_en, name_hu, name_de) VALUES ($1, 'Summary test', 'Summary test', 'Summary test') RETURNING id",
        [`ZSUM${run}`.slice(0, 20)]
    )).rows[0].id;
    const person = async (key, role, canAssist) => {
        const user = (await pool.query(
            "INSERT INTO users (name, email, password, role, is_verified, preferred_language) VALUES ($1, $2, 'not-a-password-hash', 'reviewer', true, 'en') RETURNING id, name",
            [`Summary ${key}`, `${key}-${run.toLowerCase()}@summary-test.invalid`]
        )).rows[0];
        await pool.query('INSERT INTO staff_programmes (user_id, programme_id, role, can_assist) VALUES ($1, $2, $3, $4)', [user.id, programmeId, role, canAssist]);
        return user;
    };
    main = await person('main', 'main', false);
    assisting = await person('assisting', 'extra', true);
    standby = await person('standby', 'extra', false);
    student = (await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
         VALUES ('Summary Student', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id`,
        [`student-${run.toLowerCase()}@summary-test.invalid`, `Z${run.slice(-5)}`.padEnd(6, 'Z').slice(0, 6), programmeId]
    )).rows[0];
});

after(async () => {
    if (apps.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [apps]);
    if (semesterId) await pool.query('DELETE FROM semesters WHERE id = $1', [semesterId]);
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%-${run.toLowerCase()}@summary-test.invalid`]); // links and summaries go with them
    await pool.query('DELETE FROM programmes WHERE id = $1', [programmeId]);
    await pool.end();
});

test('07:00 Budapest time, once a day, only with something new, to everyone who can see the programme', async () => {
    assert.equal(DAILY_SUMMARY_HOUR, 7);
    const a1 = await application(1);
    const a2 = await application(2);
    const a3 = await application(3);
    await event(a1, 'submitted', '2091-01-14T10:00:00Z');
    await event(a2, 'submitted', '2091-01-14T12:00:00Z');
    await event(a3, 'replied', '2091-01-14T15:00:00Z');
    const { sent, summarize } = recorder();

    // Winter time (UTC+1): 07:00 Budapest = 06:00 UTC
    assert.equal(await summaries(at('2091-01-15T05:59:59Z'), summarize), 0, '06:59:59 Budapest: not yet');
    const twice = await Promise.all([summaries(at('2091-01-15T06:00:00Z'), summarize), summaries(at('2091-01-15T06:00:00Z'), summarize)]);
    assert.equal(twice[0] + twice[1], 2, 'two summaries in total (main and assisting), also with two processes at once');
    assert.deepEqual(sent.map((s) => s.reviewer_id).sort(), [main.id, assisting.id].sort(), 'the standby extra reviewer gets none');
    const own = sent.find((s) => s.reviewer_id === main.id);
    assert.deepEqual([own.newApplications.length, own.replies.length], [2, 1], 'two new applications and one reply');
    assert.ok(own.newApplications.every((x) => x.student === 'Summary Student' && x.programme.startsWith('ZSUM')), 'student, course and programme in it');
    assert.equal(own.waiting, 3, 'waiting for a decision now');
    assert.equal(await summaries(at('2091-01-15T09:00:00Z'), summarize), 0, 'later that day: never a second one');
    assert.equal(sent.length, 2);

    // Next day, nothing new: recorded, no email
    assert.equal(await summaries(at('2091-01-16T06:00:00Z'), summarize), 0);
    const quiet = (await pool.query("SELECT count(*)::int AS n FROM reviewer_summaries WHERE reviewer_id = $1 AND day = '2091-01-16' AND emailed = false", [main.id])).rows[0].n;
    assert.equal(quiet, 1, 'the quiet day is recorded (so a later run that day sends nothing)');

    // Something new during that day; the server is off on the morning after and starts at 15:00
    const a4 = await application(4);
    await event(a4, 'submitted', '2091-01-16T10:00:00Z');
    const withdrawn = await application(5, { status: 'withdrawn' });
    await event(withdrawn, 'submitted', '2091-01-16T11:00:00Z');
    assert.equal(await summaries(at('2091-01-16T12:00:00Z'), summarize), 0, 'news after 07:00 waits for the next day');
    assert.equal(await summaries(at('2091-01-17T14:00:00Z'), summarize), 2, 'the next run that day sends it (server was off at 07:00)');
    const later = sent.slice(2).find((s) => s.reviewer_id === main.id);
    assert.deepEqual([later.newApplications.length, later.replies.length], [1, 0], 'only what came after the last summary; withdrawn ones left out');
});

test('07:00 in summer time too (UTC+2: 05:00 UTC)', async () => {
    const a6 = await application(6);
    await event(a6, 'submitted', '2091-07-09T10:00:00Z');
    const { sent, summarize } = recorder();
    assert.equal(await summaries(at('2091-07-10T04:59:59Z'), summarize), 0);
    assert.equal(await summaries(at('2091-07-10T05:00:00Z'), summarize), 2);
    assert.ok(sent.every((s) => s.newApplications.length === 1));
});

test('decisions the committee changed are in it, with the final status; kept ones are not (round 2 Group 2)', async () => {
    const changed = await application(10);
    const kept = await application(11);
    const step = (id, kind, status, iso) => pool.query(
        "INSERT INTO application_events (application_id, kind, actor_role, status, created_at) VALUES ($1, $2, 'committee', $3, $4)",
        [id, kind, status, at(iso)]
    );
    await step(changed, 'committee_changed', 'rejected', '2091-07-20T10:00:00Z');
    await step(kept, 'committee_kept', 'approved', '2091-07-20T11:00:00Z');
    const { sent, summarize } = recorder();
    assert.equal(await summaries(at('2091-07-21T06:00:00Z'), summarize), 2, 'a changed decision alone is news');
    for (const summary of sent) {
        assert.deepEqual([summary.newApplications.length, summary.replies.length, summary.changed.length], [0, 0, 1], 'only the changed one');
        assert.equal(summary.changed[0].status, 'rejected', 'with the final status');
        assert.ok(summary.changed[0].course.startsWith('ZSUM'), 'and its course');
    }
});

test('nobody who can see the programme: no summary (a standby extra reviewer, a deactivated main one)', async () => {
    const a7 = await application(7);
    await event(a7, 'submitted', '2091-08-01T10:00:00Z');
    await pool.query('UPDATE staff_programmes SET can_assist = false WHERE user_id = $1', [assisting.id]);
    await pool.query('UPDATE users SET deactivated_at = now() WHERE id = $1', [main.id]);
    const { sent, summarize } = recorder();
    assert.equal(await summaries(at('2091-08-02T06:00:00Z'), summarize), 0);
    assert.equal(sent.length, 0);
    await pool.query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [main.id]);
    await pool.query('UPDATE staff_programmes SET can_assist = true WHERE user_id = $1', [assisting.id]);
});

test('the reminders before the review deadline go to everyone who can see the programme, once each', async () => {
    semesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'active', '2091-09-01T06:00:00Z', '2091-09-30T21:59:00Z', '2091-10-14T21:59:00Z', '2091-12-31') RETURNING id`,
        [`Summary test ${run}`]
    )).rows[0].id;
    const pending = await application(8, { semester: semesterId });
    const sent = [];
    const remind = async (r) => { sent.push(r); };
    const weekBefore = at('2091-10-07T21:59:00Z');
    const twice = await Promise.all([
        remindReviewersBeforeReviewDeadline({ now: weekBefore, remind, only: [pending] }),
        remindReviewersBeforeReviewDeadline({ now: weekBefore, remind, only: [pending] }),
    ]);
    assert.equal(twice[0] + twice[1], 2, 'one each, also with two processes');
    assert.deepEqual(sent.map((r) => r.reviewer_id).sort(), [main.id, assisting.id].sort(), 'main and assisting; not the standby one');
    assert.equal(await remindReviewersBeforeReviewDeadline({ now: weekBefore, remind, only: [pending] }), 0, 'never twice');
});
