/**
 * The application period rule (utils/applicationPeriod.js, admin round Group 5; round 2 Group 1:
 * several semesters in progress) with a fake clock:
 *
 *   npm test
 *
 * Uses a test semester far in the future (in setup, judged as if it were the one in progress),
 * two more in progress in 2100 (one period in spring, the next in autumn), and late access rows
 * for addresses ending in @period-test.invalid; all deleted afterwards.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { periodFor, refuseUnlessSubmitting } = require('../utils/applicationPeriod');

let semesterId;
const EMAIL = 'late.student@period-test.invalid';
// Opens 1 Mar 2098 08:00 Budapest (UTC+1) = 07:00 UTC; closes 31 Mar 2098 23:59 Budapest (UTC+2) = 21:59 UTC
const OPENS = new Date('2098-03-01T07:00:00Z');
const CLOSES = new Date('2098-03-31T21:59:00Z');
const at = (iso) => new Date(iso);
const judge = (now, who = {}) => periodFor(pool, { now, semesterId, ...who });

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    semesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date, last_days_warning_days)
         VALUES ($1, 'setup', $2, $3, '2098-04-14T21:59:00Z', '2098-06-30', 5) RETURNING id`,
        [`Period test ${Date.now()}`, OPENS, CLOSES]
    )).rows[0].id;
});

const extra = []; // the 2100 semesters
after(async () => {
    await pool.query('DELETE FROM late_access WHERE semester_id = ANY($1)', [[semesterId, ...extra]]);
    await pool.query('DELETE FROM semesters WHERE id = ANY($1)', [[semesterId, ...extra]]);
    await pool.end();
});

test('opens and closes on its own at the set times, to the second (Budapest time)', async () => {
    assert.equal((await judge(new Date(OPENS.getTime() - 1000))).state, 'not_started');
    assert.equal((await judge(OPENS)).state, 'open');
    assert.equal((await judge(new Date(CLOSES.getTime() - 1000))).canSubmit, true);
    const after = await judge(CLOSES);
    assert.equal(after.state, 'period_over');
    assert.equal(after.canSubmit, false);
    assert.equal(after.canRegister, false);
});

test('the last-days warning uses the admin\'s number of days (here 5)', async () => {
    assert.equal((await judge(at('2098-03-26T21:58:59Z'))).state, 'open');
    assert.equal((await judge(at('2098-03-26T21:59:00Z'))).state, 'last_days');
});

test('a setup semester never takes applications by itself (the admin activates it)', async () => {
    const p = await periodFor(pool, { now: at('2098-03-10T10:00:00Z') });
    assert.ok(!(p.semester?.id === semesterId && p.canSubmit), 'not open without activation');
});

test('Close now: closed with the reason; Reopen until: open again until the new time', async () => {
    await pool.query("UPDATE semesters SET applications_close_at = $2, close_reason = 'Technical problem' WHERE id = $1", [semesterId, at('2098-03-10T10:00:00Z')]);
    const closed = await judge(at('2098-03-10T10:00:01Z'));
    assert.equal(closed.state, 'closed_by_admin');
    assert.equal(closed.semester.closeReason, 'Technical problem');
    const res = { status: (code) => ({ json: (body) => ({ code, body }) }) };
    assert.equal(refuseUnlessSubmitting(res, closed), true, 'the submit routes refuse it');

    await pool.query('UPDATE semesters SET applications_close_at = $2, close_reason = NULL WHERE id = $1', [semesterId, at('2098-03-20T21:59:00Z')]);
    assert.equal((await judge(at('2098-03-12T10:00:00Z'))).state, 'open');
    assert.equal((await judge(at('2098-03-20T21:59:00Z'))).state, 'period_over', 'closes at the new time');
    // Close now without a reason is still "closed by the admin" (an empty reason)
    await pool.query("UPDATE semesters SET applications_close_at = $2, close_reason = '' WHERE id = $1", [semesterId, at('2098-03-10T10:00:00Z')]);
    const noReason = await judge(at('2098-03-10T10:00:01Z'));
    assert.equal(noReason.state, 'closed_by_admin');
    assert.equal(noReason.semester.closeReason, null, 'no reason to show');
    await pool.query('UPDATE semesters SET applications_close_at = $2, close_reason = NULL WHERE id = $1', [semesterId, CLOSES]);
});

test('late access: register and submit until its own deadline; case-insensitive; revoking is immediate', async () => {
    const closedAt = at('2098-04-05T10:00:00Z'); // after the period closed
    assert.equal((await judge(closedAt, { email: EMAIL })).canRegister, false, 'no late access yet');

    const { rows } = await pool.query(
        'INSERT INTO late_access (email, semester_id, deadline) VALUES ($1, $2, $3) RETURNING id',
        [EMAIL, semesterId, at('2098-04-10T21:59:00Z')]
    );
    const withAccess = await judge(closedAt, { email: EMAIL.toUpperCase() });
    assert.equal(withAccess.canRegister, true, 'matched without case');
    assert.equal(withAccess.canSubmit, true);
    assert.equal(withAccess.state, 'period_over', 'the period itself stays closed');
    assert.equal(withAccess.lateAccess.deadline.toISOString(), '2098-04-10T21:59:00.000Z');
    assert.equal((await judge(closedAt, { email: 'someone.else@period-test.invalid' })).canSubmit, false, 'only for that address');
    assert.equal((await judge(at('2098-04-10T21:59:00Z'), { email: EMAIL })).canSubmit, false, 'not after its deadline');

    await pool.query('UPDATE late_access SET revoked_at = $2 WHERE id = $1', [rows[0].id, at('2098-04-05T09:00:00Z')]);
    assert.equal((await judge(closedAt, { email: EMAIL })).canSubmit, false, 'revoked: refused at once');
});

test('several semesters in progress: the open period first, then the next to open, then the most recent', async () => {
    // Spring 2100: applications in March, reviewed until mid-April; autumn 2100: applications in September
    const add = async (name, opens, closes, review) => (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'active', $2, $3, $4, '2100-12-31') RETURNING id`,
        [`${name} ${Date.now()}`, at(opens), at(closes), at(review)]
    )).rows[0].id;
    const spring = await add('Period test spring', '2100-03-01T07:00:00Z', '2100-03-31T21:59:00Z', '2100-04-14T21:59:00Z');
    extra.push(spring);
    const autumn = await add('Period test autumn', '2100-09-01T06:00:00Z', '2100-09-30T21:59:00Z', '2100-10-14T21:59:00Z');
    extra.push(autumn); // both in progress at once: allowed now

    const inSpring = await periodFor(pool, { now: at('2100-03-10T10:00:00Z') });
    assert.equal(inSpring.semester.id, spring, 'the open period');
    assert.equal(inSpring.state, 'open');
    assert.equal(inSpring.submitSemester.id, spring, 'a new application goes into the open semester');

    const between = await periodFor(pool, { now: at('2100-06-01T10:00:00Z') });
    assert.equal(between.semester.id, autumn, 'between the two: the next period to open');
    assert.equal(between.state, 'not_started');
    assert.equal(between.submitSemester, null);

    const inAutumn = await periodFor(pool, { now: at('2100-09-10T10:00:00Z') });
    assert.equal(inAutumn.semester.id, autumn, 'the spring semester may still be reviewed meanwhile');
    assert.equal(inAutumn.state, 'open');

    const later = await periodFor(pool, { now: at('2100-11-01T10:00:00Z') });
    assert.equal(later.semester.id, autumn, 'after both: the most recent period');
    assert.equal(later.state, 'period_over');

    // Late access belongs to its own semester, also while another period is open
    const { rows } = await pool.query('INSERT INTO late_access (email, semester_id, deadline) VALUES ($1, $2, $3) RETURNING id',
        [EMAIL, spring, at('2100-09-12T21:59:00Z')]);
    const late = await periodFor(pool, { now: at('2100-09-10T10:00:00Z'), email: EMAIL });
    assert.equal(late.semester.id, autumn, 'the banner talks about the open period');
    assert.equal(late.submitSemester.id, spring, "the application goes into the late access's semester");
    assert.equal(late.lateAccess.semester.id, spring);
    const lateOnly = await periodFor(pool, { now: at('2100-06-01T10:00:00Z'), email: EMAIL });
    assert.equal(lateOnly.canSubmit, true, 'late access works between the periods too');
    assert.equal(lateOnly.submitSemester.id, spring);
    await pool.query('DELETE FROM late_access WHERE id = $1', [rows[0].id]);
});

test('application periods never overlap (a database rule); the semesters themselves may', async () => {
    await assert.rejects(pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2100-03-30T10:00:00Z', '2100-04-05T10:00:00Z', '2100-04-20T10:00:00Z', '2100-12-31')`,
        [`Period test overlap ${Date.now()}`]
    ), (err) => err.code === '23P01' && err.constraint === 'semesters_periods_no_overlap');
    // Back to back is fine: closing at 21:59 and opening at 21:59 the same moment
    const id = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2100-03-31T21:59:00Z', '2100-04-05T10:00:00Z', '2100-04-20T10:00:00Z', '2100-12-31') RETURNING id`,
        [`Period test back to back ${Date.now()}`]
    )).rows[0].id;
    extra.push(id);
    // The review deadline can't be before applications close
    await assert.rejects(pool.query('UPDATE semesters SET review_end_at = applications_close_at - interval \'1 minute\' WHERE id = $1', [id]),
        (err) => err.constraint === 'semesters_times_in_order');
});
