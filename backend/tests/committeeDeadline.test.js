/**
 * The committee deadline (round 2 Group 2 Part F) with a fake clock:   npm test
 *
 * Builds its own programme (code ZCOM…) with a main reviewer, a committee-only member, a reviewer who
 * is also on the committee, and one whose committee link has ended; a student; a semester in progress
 * in 2093 and applications awaiting the committee. Every step is limited to these applications and
 * people. All deleted afterwards. No email is sent (fake senders record them).
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const {
    remindCommitteeBeforeDeadline, alertCommitteeDeadlinePassed, sendCommitteeSummaries, sendDailySummaries,
} = require('../jobs/applicationJobs');
const { COMMITTEE_DAYS_DEFAULT, COMMITTEE_WARNING_DAYS } = require('../utils/semesters');

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
const run = Date.now().toString(36).toUpperCase();
const at = (iso, offsetMs = 0) => new Date(new Date(iso).getTime() + offsetMs);

// Review deadline 20 Oct 2093 23:59 Budapest (summer time, UTC+2); the default committee deadline is
// 14 days later, 3 Nov 2093 23:59 in WINTER time (UTC+1): still 23:59 on the Budapest clock.
const REVIEW_END = '2093-10-20T21:59:00Z';
const COMMITTEE_END = '2093-11-03T22:59:00Z';
const WEEK_BEFORE = '2093-10-27T22:59:00Z'; // 7 days before, Budapest clock (winter time by then)
const DAY_BEFORE = '2093-11-02T22:59:00Z';

let programmeId;
let semesterId;
let reviewer;
let member;
let both;
let former;
let student;
const apps = [];

const person = async (key, role, links) => {
    const user = (await pool.query(
        "INSERT INTO users (name, email, password, role, is_verified, preferred_language) VALUES ($1, $2, 'not-a-password-hash', $3, true, 'en') RETURNING id, name",
        [`Committee ${key}`, `${key}-${run.toLowerCase()}@committee-test.invalid`, role]
    )).rows[0];
    for (const [linkRole, ended] of links) {
        await pool.query('INSERT INTO staff_programmes (user_id, programme_id, role, ended_at) VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END)', [user.id, programmeId, linkRole, ended]);
    }
    return user;
};

// An application awaiting the committee, decided by `decider` at `decidedAt` (with its history step)
const awaiting = async (n, decider, decidedAt) => {
    const code = `ZCOM${run}${n}`.slice(0, 20);
    const id = (await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id,
                                   reviewer_decision, reviewer_grade, decided_by, decided_by_role, decided_at, committee_state)
         VALUES ($1, $2, '[]', $3, $4, 'awaiting_committee', $5, 'approved', 4, $6, 'reviewer', $7, 'awaiting') RETURNING id`,
        [student.id, programmeId, JSON.stringify([{ course_code: code, course_name: `Committee course ${n}` }]), code, semesterId, decider.id, at(decidedAt)]
    )).rows[0].id;
    await pool.query(
        "INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, created_at) VALUES ($1, 'decided', 'reviewer', $2, 'approved', $3)",
        [id, decider.id, at(decidedAt)]
    );
    apps.push(id);
    return id;
};

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    programmeId = (await pool.query(
        "INSERT INTO programmes (code, name_en, name_hu, name_de) VALUES ($1, 'Committee test', 'Committee test', 'Committee test') RETURNING id",
        [`ZCOM${run}`.slice(0, 20)]
    )).rows[0].id;
    reviewer = await person('reviewer', 'reviewer', [['main', false]]);
    member = await person('member', 'committee', [['committee', false]]);
    both = await person('both', 'reviewer', [['extra', false], ['committee', false]]);
    // an extra reviewer allowed to assist: they see the programme as a reviewer too
    await pool.query("UPDATE staff_programmes SET can_assist = true WHERE user_id = $1 AND role = 'extra'", [both.id]);
    former = await person('former', 'committee', [['committee', true]]);
    student = (await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
         VALUES ('Committee Student', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id`,
        [`student-${run.toLowerCase()}@committee-test.invalid`, `C${run.slice(-5)}`.padEnd(6, 'C').slice(0, 6), programmeId]
    )).rows[0];
    semesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'active', '2093-09-01T06:00:00Z', '2093-09-30T21:59:00Z', $2, '2093-12-31') RETURNING id`,
        [`Committee test ${run}`, at(REVIEW_END)]
    )).rows[0].id;
});

after(async () => {
    if (apps.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [apps]);
    if (semesterId) await pool.query('DELETE FROM semesters WHERE id = $1', [semesterId]); // alerts and reminders go with it
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%-${run.toLowerCase()}@committee-test.invalid`]); // links and summaries too
    await pool.query('DELETE FROM programmes WHERE id = $1', [programmeId]);
    await pool.end();
});

test('the default committee deadline: the review deadline + COMMITTEE_DAYS_DEFAULT days, 23:59 on the Budapest clock', async () => {
    assert.equal(COMMITTEE_DAYS_DEFAULT, 14, 'the database view (migration 024) says 14 too');
    const { committee_ends_at: ends } = (await pool.query('SELECT committee_ends_at FROM semester_bounds WHERE id = $1', [semesterId])).rows[0];
    assert.equal(ends.toISOString(), at(COMMITTEE_END).toISOString(), 'across the clock change, still 23:59');
});

test('a chosen committee deadline: never before the review deadline; dropped when the review deadline moves past it', async () => {
    await assert.rejects(
        pool.query("UPDATE semesters SET committee_end_at = review_end_at - interval '1 minute' WHERE id = $1", [semesterId]),
        (err) => err.constraint === 'semesters_committee_after_review'
    );
    await pool.query("UPDATE semesters SET committee_end_at = review_end_at + interval '2 days' WHERE id = $1", [semesterId]);
    await pool.query("UPDATE semesters SET review_end_at = review_end_at + interval '1 day' WHERE id = $1", [semesterId]);
    assert.notEqual((await pool.query('SELECT committee_end_at FROM semesters WHERE id = $1', [semesterId])).rows[0].committee_end_at, null, 'still after it: kept');
    await pool.query("UPDATE semesters SET review_end_at = review_end_at + interval '5 days' WHERE id = $1", [semesterId]);
    assert.equal((await pool.query('SELECT committee_end_at FROM semesters WHERE id = $1', [semesterId])).rows[0].committee_end_at, null, 'passed by: back to the default');
    await pool.query('UPDATE semesters SET review_end_at = $2 WHERE id = $1', [semesterId, at(REVIEW_END)]);
});

test('reminders 7 days and 1 day before: every current member, once each; not the one who decided, not an ended link', async () => {
    assert.equal(COMMITTEE_WARNING_DAYS, 7);
    // Two awaiting, both decided by the reviewer; one more decided by "both" (they can't confirm it)
    const only = [await awaiting(1, reviewer, '2093-10-10T10:00:00Z'), await awaiting(2, reviewer, '2093-10-11T10:00:00Z'), await awaiting(3, both, '2093-10-12T10:00:00Z')];
    const sent = [];
    const remindCommittee = async (r) => { sent.push(r); };
    const runAt = (when) => remindCommitteeBeforeDeadline({ now: when, remindCommittee, only });

    assert.equal(await runAt(at(WEEK_BEFORE, -SECOND)), 0, 'a second before the 7-day mark: nothing');
    const twice = await Promise.all([runAt(at(WEEK_BEFORE)), runAt(at(WEEK_BEFORE))]);
    assert.equal(twice[0] + twice[1], 2, 'one each for the member and "both", also with two processes');
    const counts = Object.fromEntries(sent.map((r) => [r.member_id, r.awaiting_count]));
    assert.deepEqual(counts, { [member.id]: 3, [both.id]: 2 }, '"both" is not counted their own decision; the ended link gets nothing');
    assert.ok(sent.every((r) => r.kind === '7_days' && r.member_email && r.programme_en && r.committee_ends_at.toISOString() === at(COMMITTEE_END).toISOString()));

    assert.equal(await runAt(at(WEEK_BEFORE, 2 * DAY)), 0, 'later that week: already sent');
    assert.equal(await runAt(at(DAY_BEFORE)), 2, 'exactly 1 day before');
    assert.ok(sent.slice(2).every((r) => r.kind === '1_day'));
    assert.equal(await runAt(at(COMMITTEE_END)), 0, 'the deadline has passed: no reminder any more');
});

test('the deadline passed with applications awaiting: the admins are told once, per programme; nothing is decided', async () => {
    const only = apps.slice();
    const sent = [];
    const alertCommittee = async (a) => { sent.push(a); };
    assert.equal(await alertCommitteeDeadlinePassed({ now: at(COMMITTEE_END, -SECOND), alertCommittee, only }), 0, 'not yet');
    const twice = await Promise.all([
        alertCommitteeDeadlinePassed({ now: at(COMMITTEE_END), alertCommittee, only }),
        alertCommitteeDeadlinePassed({ now: at(COMMITTEE_END), alertCommittee, only }),
    ]);
    assert.equal(twice[0] + twice[1], 1, 'once, also with two processes');
    assert.equal(sent[0].awaiting_count, 3);
    assert.deepEqual(sent[0].programmes.map((p) => [p.code.startsWith('ZCOM'), p.awaiting]), [[true, 3]]);
    const statuses = (await pool.query('SELECT DISTINCT status FROM applications WHERE id = ANY($1)', [only])).rows.map((r) => r.status);
    assert.deepEqual(statuses, ['awaiting_committee'], 'nothing decided automatically');
    assert.equal(await alertCommitteeDeadlinePassed({ now: at(COMMITTEE_END, DAY), alertCommittee, only }), 0, 'never twice');
});

test('the members\' daily summary at 07:00: new decisions awaiting the committee, not their own; separate from the reviewer summary', async () => {
    const people = [member.id, both.id, former.id];
    const sent = [];
    const summarizeCommittee = async (s) => { sent.push(s); };
    const summaries = (iso) => sendCommitteeSummaries({ now: at(iso), summarizeCommittee, onlyMembers: people });

    // The decisions above were made on 10-12 Oct; a summary on 13 Oct covers the last 24 hours only (the first one)
    assert.equal(await summaries('2093-10-13T04:59:59Z'), 0, '06:59:59 Budapest (summer time, UTC+2): not yet');
    assert.equal(await summaries('2093-10-13T05:00:00Z'), 1, 'from 07:00: the member gets one (the decision of 12 Oct)');
    assert.equal(sent[0].member_id, member.id);
    assert.equal(sent[0].decisions.length, 1);
    assert.equal(sent[0].waiting, 3);
    const rowsOf = async (day) => (await pool.query('SELECT member_id, emailed FROM committee_summaries WHERE member_id = ANY($1) AND day = $2 ORDER BY member_id', [people, day])).rows;
    assert.deepEqual((await rowsOf('2093-10-13')).map((r) => [r.member_id, r.emailed]), [[member.id, true], [both.id, false]].sort((a, b) => a[0] - b[0]),
        '"both": recorded, no email (the only new one is their own); the ended link: nothing');
    assert.equal(await summaries('2093-10-13T09:00:00Z'), 0, 'never twice a day');

    // "both" is also a reviewer: the reviewer summary is recorded on its own, the same day
    await sendDailySummaries({ now: at('2093-10-13T05:00:01Z'), summarize: async () => {}, onlyReviewers: [both.id] });
    const reviewerRow = (await pool.query("SELECT count(*)::int AS n FROM reviewer_summaries WHERE reviewer_id = $1 AND day = '2093-10-13'", [both.id])).rows[0].n;
    const committeeRow = (await pool.query("SELECT count(*)::int AS n FROM committee_summaries WHERE member_id = $1 AND day = '2093-10-13'", [both.id])).rows[0].n;
    assert.deepEqual([reviewerRow, committeeRow], [1, 1], 'one of each kind for the same person and day');

    // A new decision by the reviewer: both members hear of it the next morning
    await awaiting(4, reviewer, '2093-10-13T12:00:00Z');
    assert.equal(await summaries('2093-10-14T05:00:00Z'), 2);
    assert.ok(sent.slice(1).every((s) => s.decisions.length === 1 && s.decisions[0].course.startsWith('ZCOM')));
});
