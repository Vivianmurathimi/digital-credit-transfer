// Reviewer access (reviewer Group 2): one active reviewer per programme, and reviewers only
// ever see their own programme's applications.

// Applications that are not decided yet: these follow the programme's reviewer
const OPEN_STATUSES = ['pending', 'needs_info'];

/**
 * The programme a request is limited to: a reviewer's own programme (read from the database
 * by verifyToken on every request), or null for the superadmin (every programme).
 */
const programmeScopeOf = (user) => (user.role === 'reviewer' ? user.programmeId : null);

/**
 * Locks the programme row for the rest of the transaction. Everything that reads or changes
 * "who is this programme's reviewer" (submit, invite acceptance, removal) takes this lock, so a
 * new application can never be assigned to a reviewer who is being replaced at that moment.
 * @param {'UPDATE'|'SHARE'} mode  SHARE for readers (submits), UPDATE for changes
 */
const lockProgramme = (client, programmeId, mode = 'UPDATE') =>
    client.query(`SELECT id FROM programmes WHERE id = $1 FOR ${mode === 'SHARE' ? 'SHARE' : 'UPDATE'}`, [programmeId]);

// The programme's active reviewer, or null
const activeReviewerOf = async (db, programmeId, { lock = false } = {}) => (await db.query(
    `SELECT id, name, email FROM users
     WHERE role = 'reviewer' AND reviewer_deactivated_at IS NULL AND programme_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [programmeId]
)).rows[0] || null;

/**
 * Whose reviewer view a request is for: a reviewer sees their own programme, the superadmin every
 * programme. (The old ?as_reviewer view filter is gone: to see exactly what a reviewer sees, the
 * superadmin now acts as them, admin round Group 1, and is then a reviewer here.)
 * @returns {Promise<{ reviewer: { id, name, programme_id } } | { all: true }>}
 */
const resolveReviewerView = async (db, req) => {
    if (req.user.role === 'reviewer') {
        const reviewer = (await db.query('SELECT id, name, programme_id FROM users WHERE id = $1', [req.user.id])).rows[0];
        return { reviewer };
    }
    return { all: true };
};

module.exports = { OPEN_STATUSES, programmeScopeOf, lockProgramme, activeReviewerOf, resolveReviewerView };
