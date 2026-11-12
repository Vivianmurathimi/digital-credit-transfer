const pool = require('../db');
const sendError = require('./sendError');

// Who may register and submit right now (admin round Group 5; round 2 Group 1: several semesters
// in progress). THE one rule: registering, submitting, saving drafts, the course list, the
// student's banner, the registration page and the admin screens all ask this; nothing else decides.
//
// Several semesters can be in progress (status 'active'): the next one's application period may
// open while the previous one is still being reviewed. Application periods never overlap (a
// database rule), so the semester the rule talks about is, in this order:
//   1. the active semester whose application period is open now (at most one),
//   2. else the active semester whose period opens next (the admin activated it already),
//   3. else the active semester whose period ended most recently (period over / Close now),
//   4. else the next semester still in setup (it only says when the period starts).
// The semester's own dates (end_date) never decide anything: only its opening and closing times
// (Close now and Reopen until change exactly those), its last-days warning, and late access.
//
// States (the semester's period, the same for everyone):
//   not_started        the semester is in setup, or its period hasn't opened
//   open               inside the period
//   last_days          inside the period, in its last N days (N set by the admin, default 3)
//   closed_by_admin    the admin used Close now (with an optional reason)
//   period_over        the period has ended
//   between_semesters  no semester in progress and none coming
// canSubmit / canRegister: open or last_days, OR the person has valid late access (until its
// deadline) in a semester in progress. A needs-info reply and withdrawing do not depend on this.
// submitSemester: where a new application goes: the late access's own semester when the person has
// one (it may be an earlier semester whose period is over), otherwise the open one; null when
// submitting isn't possible.

const SUBMITTING_STATES = ['open', 'last_days'];
const REFUSALS = {
    not_started: ['APPLICATION_PERIOD_NOT_STARTED', 'The application period has not started yet'],
    period_over: ['NO_APPLICATION_PERIOD', 'No open application period'],
    between_semesters: ['NO_APPLICATION_PERIOD', 'No open application period'],
    closed_by_admin: ['SUBMISSIONS_CLOSED', 'Submissions are currently closed'],
};

const budapestDay = (column) => `to_char(${column} AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD')`;

// The semester fields both queries read (t: the semester_bounds alias)
const semesterFields = (t) => `${t}.id, ${t}.name, ${t}.status, ${t}.opens_at, ${t}.closes_at, ${t}.review_ends_at, ${t}.close_reason,
    ${t}.last_days_warning_days, ${budapestDay(`${t}.opens_at`)} AS opens_on, ${budapestDay(`${t}.closes_at`)} AS closes_on,
    to_char(${t}.ends_on, 'YYYY-MM-DD') AS ends_on`;
const asSemester = (row) => ({
    id: row.id, name: row.name, opensAt: row.opens_at, closesAt: row.closes_at, reviewEndsAt: row.review_ends_at,
    opensOn: row.opens_on, closesOn: row.closes_on, endsOn: row.ends_on,
    closeReason: row.close_reason || null, lastDays: row.last_days_warning_days,
});

/**
 * @param {{ query: Function }} db
 * @param {{ now?: Date, userId?: number|null, email?: string|null, semesterId?: number|null }} who
 *   userId or email: whose late access counts (email: someone not registered yet).
 *   semesterId: judge that semester as if it were the one in progress (tests only).
 * @returns {Promise<{ state, canSubmit, canRegister, semester, submitSemester, lateAccess }>}
 */
const periodFor = async (db = pool, { now = new Date(), userId = null, email = null, semesterId = null } = {}) => {
    const { rows } = await db.query(
        `SELECT ${semesterFields('sb')},
                opens_at <= $1 AS started, closes_at <= $1 AS period_over, last_days_from <= $1 AS last_days
         FROM semester_bounds sb
         WHERE ($2::int IS NULL AND (status = 'active' OR (status = 'setup' AND opens_at > $1))) OR id = $2
         ORDER BY
             (id = $2) DESC NULLS LAST,
             (status = 'active' AND opens_at <= $1 AND closes_at > $1) DESC,   -- 1. open now
             (status = 'active' AND opens_at > $1) DESC,                        -- 2. active, opens next
             (status = 'active') DESC,                                          -- 3. active, period over
             CASE WHEN status = 'active' AND opens_at > $1 THEN opens_at END ASC NULLS LAST,
             CASE WHEN status = 'active' THEN closes_at END DESC NULLS LAST,    --    the most recent one
             opens_at ASC                                                       -- 4. setup, the next one
         LIMIT 1`,
        [now, semesterId]
    );
    const row = rows[0];

    // Late access: in a semester in progress, until its own deadline, revoking counts at once
    let lateAccess = null;
    if (userId || email) {
        const found = await db.query(
            `SELECT l.deadline, ${semesterFields('sb')}
             FROM late_access l JOIN semester_bounds sb ON sb.id = l.semester_id AND (sb.status = 'active' OR sb.id = $5)
             WHERE l.revoked_at IS NULL AND l.deadline > $1
               AND l.email = lower(COALESCE($2::text, (SELECT email FROM users WHERE id = $3)))
               AND ($4::int IS NULL OR l.semester_id = $4)
             ORDER BY l.deadline DESC LIMIT 1`,
            [now, email ? email.trim() : null, userId, semesterId, semesterId]
        );
        if (found.rows[0]) lateAccess = { deadline: found.rows[0].deadline, semester: asSemester(found.rows[0]) };
    }

    if (!row) {
        const canSubmit = !!lateAccess;
        return { state: 'between_semesters', canSubmit, canRegister: canSubmit, semester: null, submitSemester: lateAccess ? lateAccess.semester : null, lateAccess };
    }
    const active = row.status === 'active' || !!semesterId;
    let state;
    if (!active || !row.started) state = 'not_started';
    // close_reason: NULL = closed by its dates; '' or a text = the admin's Close now
    else if (row.period_over) state = row.close_reason !== null ? 'closed_by_admin' : 'period_over';
    else state = row.last_days ? 'last_days' : 'open';

    const semester = asSemester(row);
    const open = SUBMITTING_STATES.includes(state);
    const canSubmit = open || !!lateAccess;
    const submitSemester = lateAccess ? lateAccess.semester : (open ? semester : null);
    return { state, canSubmit, canRegister: canSubmit, semester, submitSemester, lateAccess };
};

// Answers the refusal when submitting isn't possible; returns true when it did
const refuseUnlessSubmitting = (res, period) => {
    if (period.canSubmit) return false;
    const [code, message] = REFUSALS[period.state] || REFUSALS.period_over;
    sendError(res, 403, code, message);
    return true;
};

// What the browser gets (no internal ids)
const publicSemester = (semester) => semester && {
    name: semester.name, opensAt: semester.opensAt, closesAt: semester.closesAt,
    opensOn: semester.opensOn, closesOn: semester.closesOn, endsOn: semester.endsOn,
    closeReason: semester.closeReason, lastDays: semester.lastDays,
};
const publicPeriod = ({ state, canSubmit, canRegister, semester, lateAccess }) => ({
    state,
    canSubmit,
    canRegister,
    semester: publicSemester(semester),
    // late access names its own semester: it may be an earlier one whose period is over
    lateAccess: lateAccess && { deadline: lateAccess.deadline, semester: publicSemester(lateAccess.semester) },
});

module.exports = { periodFor, refuseUnlessSubmitting, publicPeriod, SUBMITTING_STATES, REFUSALS };
