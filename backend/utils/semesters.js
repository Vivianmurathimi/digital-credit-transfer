const pool = require('../db');
const sendError = require('./sendError');

// Whether students can submit right now (Group 3). The one place that decides it: submit,
// draft saving and the form's banner all use this.
//
// States:
//   not_started        a semester is coming, its application period hasn't begun
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
const getSubmissionState = async (db = pool, now = new Date()) => {
    // Semesters can't overlap, so the first one not ended yet is the current or the coming one
    const { rows } = await db.query(
        `SELECT id, name,
                to_char(applications_open_on, 'YYYY-MM-DD') AS opens_on,
                to_char(applications_close_on, 'YYYY-MM-DD') AS closes_on,
                to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
                opens_at <= $1 AS started, closes_at <= $1 AS period_over, last_days_from <= $1 AS last_days
         FROM semester_bounds WHERE ends_at > $1 ORDER BY opens_at LIMIT 1`,
        [now]
    );
    const row = rows[0];
    if (!row) return { state: 'between_semesters', canSubmit: false, semester: null };

    const semester = { id: row.id, name: row.name, opensOn: row.opens_on, closesOn: row.closes_on, endsOn: row.ends_on };
    let state;
    if (!row.started) state = 'not_started';
    else if (row.period_over) state = 'period_over';
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
 * Creates a semester (used by npm run semester:create and the dev seed). Courses that belong to
 * no semester yet are added to it, and so are applications without one submitted during it. Refuses missing or invalid days, days out of order, a name
 * that exists and an overlap with another semester, each with a message saying what is wrong.
 * @returns {Promise<{ id: number, adoptedCourses: number, adoptedApplications: number }>}
 */
const createSemester = async (db, { name, applyFrom, applyUntil, ends }) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) throw new Error('The name is missing or longer than 50 characters.');
    for (const [label, value] of [['--apply-from', applyFrom], ['--apply-until', applyUntil], ['--ends', ends]]) {
        if (!isDay(value)) throw new Error(`${label} must be a real day written as YYYY-MM-DD (got "${value ?? ''}").`);
    }
    if (!(applyFrom <= applyUntil && applyUntil <= ends)) {
        throw new Error('The days are out of order: --apply-from <= --apply-until <= --ends.');
    }
    try {
        const { rows } = await db.query(
            'INSERT INTO semesters (name, applications_open_on, applications_close_on, ends_on) VALUES ($1, $2, $3, $4) RETURNING id',
            [name.trim(), applyFrom, applyUntil, ends]
        );
        return { id: rows[0].id, ...(await adoptIntoSemester(db, rows[0].id)) };
    } catch (err) {
        if (err.code === '23505') throw new Error(`A semester called "${name.trim()}" already exists.`);
        if (err.code === '23P01') {
            const other = await db.query(
                "SELECT name, applications_open_on::text AS f, ends_on::text AS t FROM semesters WHERE daterange(applications_open_on, ends_on, '[]') && daterange($1::date, $2::date, '[]') LIMIT 1",
                [applyFrom, ends]
            );
            const o = other.rows[0];
            throw new Error(`It overlaps ${o ? `"${o.name}" (${o.f} to ${o.t})` : 'another semester'}: semesters can't overlap.`);
        }
        throw err;
    }
};

module.exports = { getSubmissionState, refuseUnlessSubmitting, publicSubmissionState, createSemester, adoptIntoSemester, SUBMITTING_STATES };
