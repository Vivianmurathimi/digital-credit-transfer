// Activating and deleting staff accounts (fixes, Group 1a; migration 025). Reviewers, committee
// members and admins. Students are never deactivated or deleted here.
//
// ACTIVATE gives the SAME account back: same id, password, name and history. The links its
// deactivation ended (staff_programmes.ended_by_deactivation) come back as new link rows with the
// same role; the ended rows stay as history. A main reviewer link whose programme has got another
// main reviewer meanwhile comes back as an extra reviewer on standby (one main per programme), and
// the answer says so. Applications that were assigned to them stay shared.
//
// DELETE: without history the account is deleted for real. With history (anything below), the row
// stays so the name stays on those records and in the PDF book: it is deactivated, hidden from every
// list (deleted_at), its email becomes deleted-<id>@invalid (the address can be invited again as a
// new account) and its password can never match. Either way its current links end first, like a
// removal (assigned open applications become shared again; a lost main reviewer is reported).
//
// "History" is checked here, column by column, on purpose: several of these references are
// ON DELETE SET NULL in the database, so a real delete would silently empty "who did it".

const { lockProgrammes, endLink } = require('./reviewers');

const STAFF_ROLES = ['reviewer', 'committee', 'superadmin'];

// Every record that names the person as the one who acted ($1 = the user id)
const HISTORY = [
    ['applications', 'decided_by'],
    ['applications', 'committee_by'],
    ['applications', 'reviewed_by'],
    ['applications', 'assigned_reviewer_id'],
    ['application_events', 'actor_id'],
    ['acting_sessions', 'admin_id'],
    ['acting_sessions', 'person_id'],
    ['staff_invites', 'invited_by'],
    ['staff_programmes', 'created_by'],
    ['late_access', 'granted_by'],
    ['late_access', 'revoked_by'],
    ['semesters', 'closed_by'],
    ['student_programme_changes', 'changed_by'],
    ['allowed_domains', 'added_by'],
];
const HISTORY_SQL = `SELECT ${HISTORY.map(([table, column]) => `EXISTS (SELECT 1 FROM ${table} WHERE ${column} = $1)`).join(' OR ')} AS has_history`;

const hasHistory = async (db, userId) => (await db.query(HISTORY_SQL, [userId])).rows[0].has_history === true;

// The placeholder address of a deleted account that keeps its history
const deletedEmail = (userId) => `deleted-${userId}@invalid`;

/**
 * Locks every active admin row (id order), so two admins acting on each other at the same moment
 * can't leave nobody. Returns their ids.
 */
const lockActiveAdmins = async (client) => (await client.query(
    "SELECT id FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL ORDER BY id FOR UPDATE"
)).rows.map((row) => row.id);

/**
 * Activates a deactivated staff account (inside the caller's transaction).
 * @returns {Promise<{ error?: [status, code, message], alreadyActive?: true, restored?: Array<{ code, role }>, becameExtra?: string[] }>}
 */
const activateAccount = async (client, userId) => {
    const user = (await client.query('SELECT id, role, deactivated_at, deleted_at FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!user || user.deleted_at) return { error: [404, 'USER_NOT_FOUND', 'User not found'] };
    if (!STAFF_ROLES.includes(user.role)) return { error: [400, 'NOT_STAFF', 'Only reviewers, committee members and admins are activated here'] };
    if (!user.deactivated_at) return { alreadyActive: true, restored: [], becameExtra: [] };

    // The links ended by THIS deactivation (the same moment), newest row per programme and side.
    // Compared in the database: a JavaScript date keeps only milliseconds, the column microseconds.
    const links = (await client.query(
        `SELECT DISTINCT ON (sp.programme_id, (sp.role = 'committee')) sp.programme_id, sp.role, sp.can_assist, p.code
         FROM staff_programmes sp JOIN programmes p ON p.id = sp.programme_id JOIN users u ON u.id = sp.user_id
         WHERE sp.user_id = $1 AND sp.ended_by_deactivation AND sp.ended_at = u.deactivated_at
         ORDER BY sp.programme_id, (sp.role = 'committee'), sp.id DESC`,
        [userId]
    )).rows;
    await lockProgrammes(client, links.map((l) => l.programme_id));
    await client.query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [userId]);

    const restored = [];
    const becameExtra = [];
    for (const link of links) {
        // Already back on this side of the programme (e.g. through an invite): nothing to add
        const current = (await client.query(
            "SELECT 1 FROM staff_programmes WHERE user_id = $1 AND programme_id = $2 AND ended_at IS NULL AND (role = 'committee') = ($3 = 'committee')",
            [userId, link.programme_id, link.role]
        )).rows.length > 0;
        if (current) continue;
        let { role } = link;
        let canAssist = link.role === 'extra' && link.can_assist;
        if (role === 'main') {
            const otherMain = (await client.query(
                "SELECT 1 FROM staff_programmes WHERE programme_id = $1 AND role = 'main' AND ended_at IS NULL", [link.programme_id]
            )).rows.length > 0;
            if (otherMain) { role = 'extra'; canAssist = false; becameExtra.push(link.code); }
        }
        await client.query('INSERT INTO staff_programmes (user_id, programme_id, role, can_assist) VALUES ($1, $2, $3, $4)', [userId, link.programme_id, role, canAssist]);
        restored.push({ code: link.code, role });
    }
    return { alreadyActive: false, restored, becameExtra };
};

/**
 * Deletes a staff account (inside the caller's transaction): for real without history, hidden with it.
 * Refused for yourself and for the last active admin.
 * @returns {Promise<{ error?: [status, code, message], outcome?: 'deleted'|'hidden', lostMain?: number[], unassigned?: number }>}
 */
const deleteAccount = async (client, { userId, actorId }) => {
    if (userId === actorId) return { error: [400, 'CANNOT_DELETE_SELF', 'You cannot delete your own account'] };
    const activeAdmins = await lockActiveAdmins(client);
    const user = (await client.query('SELECT id, role, email, deactivated_at, deleted_at FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!user || user.deleted_at) return { error: [404, 'USER_NOT_FOUND', 'User not found'] };
    if (!STAFF_ROLES.includes(user.role)) return { error: [400, 'NOT_STAFF', 'Only reviewers, committee members and admins are deleted here'] };
    if (user.role === 'superadmin' && !user.deactivated_at && (!activeAdmins.includes(actorId) || activeAdmins.length <= 1)) {
        return { error: [409, 'LAST_ADMIN', 'The last active admin cannot be deactivated or deleted'] };
    }

    // Like a removal first: every current link ends (assigned open applications shared again)
    const links = (await client.query('SELECT id, programme_id, role FROM staff_programmes WHERE user_id = $1 AND ended_at IS NULL', [userId])).rows;
    await lockProgrammes(client, links.map((l) => l.programme_id));
    let unassigned = 0;
    for (const link of links) unassigned += await endLink(client, { linkId: link.id, userId, programmeId: link.programme_id });
    const lostMain = links.filter((l) => l.role === 'main').map((l) => l.programme_id);
    await client.query('UPDATE acting_sessions SET ended_at = now() WHERE (person_id = $1 OR admin_id = $1) AND ended_at IS NULL', [userId]);
    // Open invites to this address stop working (the account is gone or hidden)
    await client.query('UPDATE staff_invites SET cancelled_at = now() WHERE email = $1 AND accepted_at IS NULL AND cancelled_at IS NULL', [user.email]);

    if (await hasHistory(client, userId)) {
        await client.query(
            `UPDATE users SET deleted_at = now(), deactivated_at = COALESCE(deactivated_at, now()), email = $2,
                 password = '!', verification_token = NULL, reset_password_token = NULL, reset_password_expires = NULL
             WHERE id = $1`,
            [userId, deletedEmail(userId)]
        );
        return { outcome: 'hidden', lostMain, unassigned };
    }
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    return { outcome: 'deleted', lostMain, unassigned };
};

module.exports = { HISTORY, hasHistory, deletedEmail, lockActiveAdmins, activateAccount, deleteAccount };
