const pool = require('../db');
const sendError = require('./sendError');

// Whether students can submit right now (Group 3). The one place that decides it: submit,
// draft saving and the form's banner all use this.
//
// States:
//   not_started        no active semester yet (one in setup), or the active one's period hasn't begun
//   open               inside the application period, admin toggle open
//   last_days          the same, in its last 7 days (the form warns about the semester end)
//   closed_by_admin    inside the application period, but the admin closed submissions
//   period_over        the semester runs, its application period is over
//   between_semesters  no current and no coming semester
// Only "open" and "last_days" allow submitting. All moments are Budapest time (semester_bounds).

const SUBMITTING_STATES = ['open', 'last_days'];

// What a refused submit (or draft save) answers in each state
const REFUSALS = {
    not_started: ['APPLICATION_PERIOD_NOT_STARTED', 'The application period has not started yet'],
    period_over: ['NO_APPLICATION_PERIOD', 'No open application period'],
    between_semesters: ['NO_APPLICATION_PERIOD', 'No open application period'],
    closed_by_admin: ['SUBMISSIONS_CLOSED', 'Submissions are currently closed'],
};

/**
 * @param {{ query: Function }} db  pool or transaction client
 * @param {Date} now  the moment to judge (a fixed time in tests)
 * @returns {Promise<{ state: string, canSubmit: boolean, semester: null | { id, name, opensOn, closesOn, endsOn } }>}
 *   semester: the current one, or the coming one when not started; dates as 'YYYY-MM-DD' (Budapest days)
 */
const getSubmissionState = async (db = pool, now = new Date(), { semesterId = null } = {}) => {
    // The ACTIVE semester (admin round Group 4: the admin activates it); without one, the coming
    // setup semester, only to say when the period starts. Inside the active semester the
    // application period opens and closes on its own times.
    const { rows } = await db.query(
        `SELECT id, name, status,
                to_char(opens_at AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD') AS opens_on,
                to_char(closes_at AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD') AS closes_on,
                to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
                opens_at <= $1 AS started, closes_at <= $1 AS period_over, last_days_from <= $1 AS last_days, ends_at <= $1 AS ended
         FROM semester_bounds
         WHERE ($2::int IS NULL AND (status = 'active' OR (status = 'setup' AND ends_at > $1))) OR id = $2
         ORDER BY (status = 'active') DESC, opens_at LIMIT 1`,
        [now, semesterId]
    );
    const row = rows[0];
    if (!row) return { state: 'between_semesters', canSubmit: false, semester: null };

    const semester = { id: row.id, name: row.name, opensOn: row.opens_on, closesOn: row.closes_on, endsOn: row.ends_on };
    let state;
    // (tests pass semesterId to judge one semester's dates as if it were the active one)
    if ((row.status !== 'active' && !semesterId) || !row.started) state = 'not_started';
    else if (row.period_over || row.ended) state = 'period_over';
    else {
        const toggle = await db.query('SELECT is_submissions_open FROM system_settings LIMIT 1');
        if (!toggle.rows[0]?.is_submissions_open) state = 'closed_by_admin';
        else state = row.last_days ? 'last_days' : 'open';
    }
    return { state, canSubmit: SUBMITTING_STATES.includes(state), semester };
};

// Answers the refusal for a state that doesn't allow submitting; returns true when it did
const refuseUnlessSubmitting = (res, submission) => {
    if (submission.canSubmit) return false;
    const [code, message] = REFUSALS[submission.state];
    sendError(res, 403, code, message);
    return true;
};

// The part the browser gets (no internal ids)
const publicSubmissionState = ({ state, canSubmit, semester }) => ({
    state,
    canSubmit,
    semester: semester && { name: semester.name, opensOn: semester.opensOn, closesOn: semester.closesOn, endsOn: semester.endsOn },
});

// A real calendar day written as YYYY-MM-DD (2026-02-30 is refused)
const isDay = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/**
 * Courses without a semester join this one, and so do applications without one that were
 * submitted during it (created_at is stored as UTC without a time zone). Safe to run again.
 * @returns {Promise<{ adoptedCourses: number, adoptedApplications: number }>}
 */
const adoptIntoSemester = async (db, semesterId) => {
    const courses = await db.query('UPDATE courses SET semester_id = $1 WHERE semester_id IS NULL', [semesterId]);
    const applications = await db.query(
        `UPDATE applications a SET semester_id = b.id FROM semester_bounds b
         WHERE b.id = $1 AND a.semester_id IS NULL
           AND a.created_at AT TIME ZONE 'UTC' >= b.opens_at AND a.created_at AT TIME ZONE 'UTC' < b.ends_at`,
        [semesterId]
    );
    return { adoptedCourses: courses.rowCount, adoptedApplications: applications.rowCount };
};

/**
 * Creates a semester (npm run semester:create, the dev seed, the demo and the tests; the admin
 * screen has its own route). Days are Budapest days: applications from 00:00 on applyFrom until
 * 23:59 on applyUntil; the semester ends after `ends`. status: setup (default), active (only when
 * no other one is active) or closed (closedAt = its end). Courses without a semester join it, and
 * so do applications without one submitted during it. Refuses invalid or out-of-order days, a
 * name that exists and an overlap, each with a message saying what is wrong.
 * @returns {Promise<{ id: number, adoptedCourses: number, adoptedApplications: number }>}
 */
const createSemester = async (db, { name, applyFrom, applyUntil, ends, status = 'setup' }) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) throw new Error('The name is missing or longer than 50 characters.');
    for (const [label, value] of [['--apply-from', applyFrom], ['--apply-until', applyUntil], ['--ends', ends]]) {
        if (!isDay(value)) throw new Error(`${label} must be a real day written as YYYY-MM-DD (got "${value ?? ''}").`);
    }
    if (!(applyFrom <= applyUntil && applyUntil <= ends)) {
        throw new Error('The days are out of order: --apply-from <= --apply-until <= --ends.');
    }
    if (!['setup', 'active', 'closed'].includes(status)) throw new Error('status must be setup, active or closed.');
    try {
        const { rows } = await db.query(
            `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, end_date, closed_at)
             VALUES ($1, $5::varchar, $2::date::timestamp AT TIME ZONE 'Europe/Budapest',
                     ($3::date::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', $4::date,
                     CASE WHEN $5::varchar = 'closed' THEN ($4::date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' END)
             RETURNING id`,
            [name.trim(), applyFrom, applyUntil, ends, status]
        );
        return { id: rows[0].id, ...(await adoptIntoSemester(db, rows[0].id)) };
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'semesters_one_active') throw new Error('Another semester is already active.');
        if (err.code === '23505') throw new Error(`A semester called "${name.trim()}" already exists.`);
        if (err.code === '23P01') {
            const other = await db.query(
                `SELECT name, to_char(opens_at AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD') AS f, ends_on::text AS t FROM semester_bounds
                 WHERE daterange((opens_at AT TIME ZONE 'Europe/Budapest')::date, ends_on, '[]') && daterange($1::date, $2::date, '[]') LIMIT 1`,
                [applyFrom, ends]
            );
            const o = other.rows[0];
            throw new Error(`It overlaps ${o ? `"${o.name}" (${o.f} to ${o.t})` : 'another semester'}: semesters can't overlap.`);
        }
        throw err;
    }
};

/**
 * SQL: the application's semester has ended (reviewer group L3). Past semesters are read-only:
 * no status change of any kind, for anyone. `table` is the applications table's name or alias.
 * Applications without a semester never count as ended.
 */
const semesterEndedSql = (table = 'applications') =>
    `EXISTS (SELECT 1 FROM semester_bounds ended WHERE ended.id = ${table}.semester_id AND (ended.ends_at <= now() OR ended.status = 'closed'))`;

// SQL for "the current semester" (admin round Group 4): the active one, set by the admin
const CURRENT_SEMESTER_SQL = "SELECT id, name FROM semester_bounds WHERE status = 'active' LIMIT 1";

module.exports = { CURRENT_SEMESTER_SQL, semesterEndedSql, getSubmissionState, refuseUnlessSubmitting, publicSubmissionState, createSemester, adoptIntoSemester, SUBMITTING_STATES };
