// Reviewer access (reviewer Group 2; round 2 Group 1 Part B: staff linked to programmes).
//
// A reviewer's programmes are in staff_programmes (migration 019), never in users.programme_id
// (students only). Per programme: at most one MAIN reviewer (a database rule) and any number of
// EXTRA reviewers. Who sees a programme's applications:
//   - its main reviewer, always;
//   - an extra reviewer only while "allowed to assist" (can_assist) is on. A standby extra
//     reviewer sees nothing of that programme.
// Committee members (round 2 Group 2): links with role 'committee' (any number per programme, no
// main). Someone only on a committee has users.role 'committee'; a reviewer may also have
// committee links. Committee access always comes from the CURRENT committee links.
// verifyToken reads these from the database on every request (req.user.programmeIds,
// req.user.committeeProgrammeIds), so a change by the admin takes effect from the next request on.

// The two sides of a link: reviewer (main, extra) and committee
const REVIEWER_ROLES = ['main', 'extra'];
const LINK_ROLES = ['main', 'extra', 'committee'];
const sideOf = (role) => (role === 'committee' ? 'committee' : 'reviewer');
// SQL: a link of the same side as $role (alias sp)
const sameSideSql = (sp, param) => `(${sp}.role = 'committee') = (${param}::text = 'committee')`;

// Applications that are not decided yet
const OPEN_STATUSES = ['pending', 'needs_info'];
const STAFF_ROLES = ['main', 'extra'];

// A current link that lets its person see the programme (alias: the staff_programmes row)
const seesProgrammeSql = (sp = 'sp') => `${sp}.ended_at IS NULL AND (${sp}.role = 'main' OR (${sp}.role = 'extra' AND ${sp}.can_assist))`;

/**
 * Whether someone active can see (and decide) a programme's applications now: its main reviewer,
 * or an assisting extra reviewer. Without one, the programme's applications wait for the admin.
 * @param {string} programmeColumn  e.g. 'a.programme_id' or 'p.id'
 */
const programmeHasReviewerSql = (programmeColumn) => `EXISTS (
    SELECT 1 FROM staff_programmes hr JOIN users hru ON hru.id = hr.user_id AND hru.deactivated_at IS NULL
    WHERE hr.programme_id = ${programmeColumn} AND ${seesProgrammeSql('hr')})`;

/**
 * The programmes whose applications this person may see, as an id list (empty: none).
 * @returns {Promise<number[]>}
 */
const visibleProgrammeIds = async (db, userId) => (await db.query(
    `SELECT sp.programme_id FROM staff_programmes sp WHERE sp.user_id = $1 AND ${seesProgrammeSql('sp')} ORDER BY sp.programme_id`,
    [userId]
)).rows.map((row) => row.programme_id);

// The programmes whose committee this person is on now (current committee links), as an id list
const committeeProgrammeIds = async (db, userId) => (await db.query(
    "SELECT sp.programme_id FROM staff_programmes sp WHERE sp.user_id = $1 AND sp.role = 'committee' AND sp.ended_at IS NULL ORDER BY sp.programme_id",
    [userId]
)).rows.map((row) => row.programme_id);

// A person's current committee links, with the programme names
const committeeProgrammes = async (db, userId) => (await db.query(
    `SELECT sp.programme_id, p.code, p.name_en, p.name_hu, p.name_de
     FROM staff_programmes sp JOIN programmes p ON p.id = sp.programme_id
     WHERE sp.user_id = $1 AND sp.role = 'committee' AND sp.ended_at IS NULL ORDER BY p.code`,
    [userId]
)).rows;

/**
 * Every current REVIEWER-side link of a person (main, extra), with the programme and whether it lets them see it.
 * @returns {Promise<Array<{ programme_id, code, name_en, name_hu, name_de, role, can_assist, sees }>>}
 */
const reviewerProgrammes = async (db, userId) => (await db.query(
    `SELECT sp.programme_id, p.code, p.name_en, p.name_hu, p.name_de, sp.role, sp.can_assist, ${seesProgrammeSql('sp')} AS sees
     FROM staff_programmes sp JOIN programmes p ON p.id = sp.programme_id
     WHERE sp.user_id = $1 AND sp.ended_at IS NULL AND sp.role IN ('main', 'extra')
     ORDER BY p.code`,
    [userId]
)).rows;

/**
 * The programme ids a request is limited to: a reviewer's visible programmes (read from the
 * database by verifyToken on every request), or null for the superadmin (every programme).
 * Used in SQL as ($n::int[] IS NULL OR a.programme_id = ANY($n::int[])).
 */
const programmeScopeOf = (user) => (user.role === 'reviewer' ? (user.programmeIds || []) : null);

/**
 * Locks the programme row for the rest of the transaction. Everything that reads or changes
 * "who reviews this programme" (invite acceptance, adding or ending a link, removal) takes this
 * lock. Several programmes: always in id order, so two changes never wait for each other.
 * @param {'UPDATE'|'SHARE'} mode  SHARE for readers, UPDATE for changes
 */
const lockProgramme = (client, programmeId, mode = 'UPDATE') =>
    client.query(`SELECT id FROM programmes WHERE id = $1 FOR ${mode === 'SHARE' ? 'SHARE' : 'UPDATE'}`, [programmeId]);
const lockProgrammes = async (client, programmeIds, mode = 'UPDATE') => {
    for (const id of [...new Set(programmeIds)].sort((a, b) => a - b)) await lockProgramme(client, id, mode);
};

// The programme's current main reviewer (an active account), or null
const mainReviewerOf = async (db, programmeId, { lock = false } = {}) => (await db.query(
    `SELECT u.id, u.name, u.email, sp.id AS link_id FROM staff_programmes sp JOIN users u ON u.id = sp.user_id
     WHERE sp.programme_id = $1 AND sp.role = 'main' AND sp.ended_at IS NULL AND u.deactivated_at IS NULL${lock ? ' FOR UPDATE OF sp' : ''}`,
    [programmeId]
)).rows[0] || null;

/**
 * Ends one link (inside the caller's transaction, programme locked). The person's open
 * applications assigned to them in that programme become shared again, or go to `handOverTo`
 * (a swap). Returns how many applications changed.
 */
const endLink = async (client, { linkId, userId, programmeId, handOverTo = null }) => {
    const ended = (await client.query('UPDATE staff_programmes SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING role', [linkId])).rows[0];
    // A committee link has no assigned applications: ending it never touches the person's reviewer work
    if (ended && ended.role === 'committee') return 0;
    return (await client.query(
        'UPDATE applications SET assigned_reviewer_id = $4 WHERE assigned_reviewer_id = $1 AND programme_id = $2 AND status = ANY($3)',
        [userId, programmeId, OPEN_STATUSES, handOverTo]
    )).rowCount;
};

/**
 * Whose reviewer view a request is for: a reviewer sees their visible programmes, the superadmin
 * every programme. (The superadmin sees exactly what a reviewer sees by acting as them.)
 * @returns {Promise<{ reviewer: { id, name, programmeIds: number[], programmes: object[] } } | { all: true }>}
 */
const resolveReviewerView = async (db, req) => {
    if (req.user.role === 'reviewer') {
        const reviewer = (await db.query('SELECT id, name FROM users WHERE id = $1', [req.user.id])).rows[0];
        const programmes = await reviewerProgrammes(db, req.user.id);
        return { reviewer: { ...reviewer, programmeIds: programmeScopeOf(req.user), programmes } };
    }
    return { all: true };
};

module.exports = {
    REVIEWER_ROLES, LINK_ROLES, sideOf, sameSideSql, committeeProgrammeIds, committeeProgrammes,
    OPEN_STATUSES, STAFF_ROLES, seesProgrammeSql, programmeHasReviewerSql, visibleProgrammeIds, reviewerProgrammes,
    programmeScopeOf, lockProgramme, lockProgrammes, mainReviewerOf, endLink, resolveReviewerView,
};
