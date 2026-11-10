const pool = require('../db');
const sendError = require('./sendError');

// Who may register and submit right now (admin round Group 5). THE one rule: registering,
// submitting, saving drafts, the course list, the student's banner, the registration page and
// the admin screens all ask this; nothing else decides.
//
// It reads the ACTIVE semester (the admin activates one; without one, the coming setup semester
// only says when the period starts), its opening and closing times (Close now and Reopen until
// change exactly those), its last-days warning, and the person's late access.
//
// States (the semester's period, the same for everyone):
//   not_started        no active semester yet (one in setup), or the active one hasn't opened
//   open               inside the period
//   last_days          inside the period, in its last N days (N set by the admin, default 3)
//   closed_by_admin    the admin used Close now (with an optional reason)
//   period_over        the period has ended (or the semester itself)
//   between_semesters  no active and no coming semester
// canSubmit / canRegister: open or last_days, OR the person has valid late access (until its
// deadline) in the active semester. A needs-info reply and withdrawing do not depend on this.

const SUBMITTING_STATES = ['open', 'last_days'];
const REFUSALS = {
    not_started: ['APPLICATION_PERIOD_NOT_STARTED', 'The application period has not started yet'],
    period_over: ['NO_APPLICATION_PERIOD', 'No open application period'],
    between_semesters: ['NO_APPLICATION_PERIOD', 'No open application period'],
    closed_by_admin: ['SUBMISSIONS_CLOSED', 'Submissions are currently closed'],
};

const budapestDay = (column) => `to_char(${column} AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD')`;

/**
 * @param {{ query: Function }} db
 * @param {{ now?: Date, userId?: number|null, email?: string|null, semesterId?: number|null }} who
 *   userId or email: whose late access counts (email: someone not registered yet).
 *   semesterId: judge that semester as if it were the active one (tests only).
 * @returns {Promise<{ state, canSubmit, canRegister, semester, lateAccess }>}
 */
const periodFor = async (db = pool, { now = new Date(), userId = null, email = null, semesterId = null } = {}) => {
    const { rows } = await db.query(
        `SELECT id, name, status, opens_at, closes_at, close_reason, last_days_warning_days,
                ${budapestDay('opens_at')} AS opens_on, ${budapestDay('closes_at')} AS closes_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
                opens_at <= $1 AS started, closes_at <= $1 AS period_over, last_days_from <= $1 AS last_days, ends_at <= $1 AS ended
         FROM semester_bounds
         WHERE ($2::int IS NULL AND (status = 'active' OR (status = 'setup' AND ends_at > $1))) OR id = $2
         ORDER BY (status = 'active') DESC, opens_at LIMIT 1`,
        [now, semesterId]
    );
    const row = rows[0];
    if (!row) return { state: 'between_semesters', canSubmit: false, canRegister: false, semester: null, lateAccess: null };

    const active = row.status === 'active' || !!semesterId;
    const semester = {
        id: row.id, name: row.name, opensAt: row.opens_at, closesAt: row.closes_at,
        opensOn: row.opens_on, closesOn: row.closes_on, endsOn: row.ends_on,
        closeReason: row.close_reason || null, lastDays: row.last_days_warning_days,
    };
    let state;
    if (!active || !row.started) state = 'not_started';
    else if (row.ended) state = 'period_over';
    // close_reason: NULL = closed by its dates; '' or a text = the admin's Close now
    else if (row.period_over) state = row.close_reason !== null ? 'closed_by_admin' : 'period_over';
    else state = row.last_days ? 'last_days' : 'open';

    // Late access: only in the active semester, until its own deadline, revoking counts at once
    let lateAccess = null;
    if (active && !row.ended && (userId || email)) {
        const found = await db.query(
            `SELECT l.deadline FROM late_access l
             WHERE l.semester_id = $1 AND l.revoked_at IS NULL AND l.deadline > $2
               AND l.email = lower(COALESCE($3::text, (SELECT email FROM users WHERE id = $4)))
             ORDER BY l.deadline DESC LIMIT 1`,
            [row.id, now, email ? email.trim() : null, userId]
        );
        if (found.rows[0]) lateAccess = { deadline: found.rows[0].deadline };
    }
    const canSubmit = SUBMITTING_STATES.includes(state) || !!lateAccess;
    return { state, canSubmit, canRegister: canSubmit, semester, lateAccess };
};

// Answers the refusal when submitting isn't possible; returns true when it did
const refuseUnlessSubmitting = (res, period) => {
    if (period.canSubmit) return false;
    const [code, message] = REFUSALS[period.state] || REFUSALS.period_over;
    sendError(res, 403, code, message);
    return true;
};

// What the browser gets (no internal ids)
const publicPeriod = ({ state, canSubmit, canRegister, semester, lateAccess }) => ({
    state,
    canSubmit,
    canRegister,
    semester: semester && {
        name: semester.name, opensAt: semester.opensAt, closesAt: semester.closesAt,
        opensOn: semester.opensOn, closesOn: semester.closesOn, endsOn: semester.endsOn,
        closeReason: semester.closeReason, lastDays: semester.lastDays,
    },
    lateAccess: lateAccess && { deadline: lateAccess.deadline },
});

module.exports = { periodFor, refuseUnlessSubmitting, publicPeriod, SUBMITTING_STATES, REFUSALS };
