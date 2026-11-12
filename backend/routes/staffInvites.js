const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { requireIdParam } = require('../utils/validate');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const { normalizeLanguage } = require('../utils/emailTemplates');
const { LIMITS, takeSlot, normalizeEmail, clientIp } = require('../utils/rateLimit');
const { checkPassword } = require('../utils/passwordRules');
const { STAFF_ROLES, lockProgrammes, mainReviewerOf, endLink } = require('../utils/reviewers');
const { notifyAdminsNoMainReviewer } = require('../utils/notifyAdmins');
const {
    INVITE_DAYS, INVITE_ROLES, INVITE_STATUSES, INVITE_STATUS_SQL, OPEN_INVITE,
    newToken, hashToken, inviteLink, isValidInviteEmail, sendInviteEmail, checkInviteAddress, createInvite,
} = require('../utils/staffInvites');
const { sendValidationErrors } = sendError;

// Staff access (reviewer Group 2, admin round Group 2). Reviewers and admins never register:
// the superadmin invites them. Registration only ever creates students (routes/auth.js).
//
// Reviewers are linked to programmes in staff_programmes (round 2 Group 1, utils/reviewers.js):
// per programme one MAIN reviewer at most, and any number of EXTRA reviewers. A reviewer invite
// names one or more programmes and the role in each.
// Accepting it is where a programme's main reviewer changes (one transaction, programmes locked):
//   1. a main role for a programme that has a main reviewer: refused, unless the invite swaps
//      them (replace). Then the old main reviewer's link ends, and their open applications assigned
//      to them go to the new person; an old reviewer left with no programme is deactivated.
//      An extra role never replaces anyone.
//   2. the new reviewer is created, or a deactivated reviewer with this email is reactivated,
//   3. the new links are made (an extra reviewer starts on standby: can_assist off).
// Until then the current reviewers keep full access. Decided applications never move.
// An admin invite creates (or reactivates) an admin; it has no programme.
// An active reviewer gets another programme (or another role in one) without an invite:
// POST /users/:id/programmes; DELETE /users/:id/programmes/:code ends one link.

const MAX_NAME_LENGTH = 100; // users.name

const MAX_PROGRAMMES = 50; // per invite: more than any faculty has

// An invite's programmes, as [{ code, name_en, name_hu, name_de, role, replace }] (alias i = staff_invites)
const INVITE_PROGRAMMES_SQL = `COALESCE((
    SELECT json_agg(json_build_object('code', p.code, 'name_en', p.name_en, 'name_hu', p.name_hu, 'name_de', p.name_de,
                                      'role', ip.role, 'replace', ip.replace_main) ORDER BY p.code)
    FROM staff_invite_programmes ip JOIN programmes p ON p.id = ip.programme_id
    WHERE ip.invite_id = i.id), '[]')`;

// What the superadmin sees of an invite (never the token or its hash)
const INVITE_COLUMNS = `
    i.id, i.email, i.role, i.language, i.created_at, i.expires_at,
    i.accepted_at, i.cancelled_at, ${INVITE_STATUS_SQL} AS status,
    ${INVITE_PROGRAMMES_SQL} AS programmes, inviter.name AS invited_by_name`;
const INVITE_FROM = `
    FROM staff_invites i
    LEFT JOIN users inviter ON inviter.id = i.invited_by`;

const readInvite = async (id) => (await pool.query(`SELECT ${INVITE_COLUMNS} ${INVITE_FROM} WHERE i.id = $1`, [id])).rows[0];

/**
 * The programmes of a reviewer invite from the request: programmes: [{ code, role, replace? }],
 * or the short form programme_code (+ replace) for one programme as its main reviewer.
 * @returns {{ list: Array<{ code, role, replace }> } | { error: [status, code, message, field] }}
 */
const readProgrammeChoices = ({ programmes, programme_code: programmeCode, replace }) => {
    if (replace !== undefined && typeof replace !== 'boolean') return { error: [400, 'INVALID_FIELD', 'replace must be true or false', 'replace'] };
    let list;
    if (programmes !== undefined) {
        if (programmeCode !== undefined || replace !== undefined) {
            return { error: [400, 'INVALID_FIELD', 'Send either programmes or programme_code, not both', 'programmes'] };
        }
        if (!Array.isArray(programmes) || programmes.length > MAX_PROGRAMMES) return { error: [400, 'INVALID_PROGRAMME', 'programmes must be a list', 'programmes'] };
        list = programmes;
    } else {
        list = programmeCode === undefined || programmeCode === null || programmeCode === '' ? [] : [{ code: programmeCode, role: 'main', replace }];
    }
    const seen = new Set();
    for (const item of list) {
        if (!item || typeof item.code !== 'string' || !item.code.trim()) return { error: [400, 'INVALID_PROGRAMME', 'Unknown study programme', 'programmes'] };
        if (!STAFF_ROLES.includes(item.role)) return { error: [400, 'INVALID_STAFF_ROLE', 'role must be main or extra', 'programmes'] };
        if (item.replace !== undefined && typeof item.replace !== 'boolean') return { error: [400, 'INVALID_FIELD', 'replace must be true or false', 'programmes'] };
        if (item.replace === true && item.role !== 'main') return { error: [400, 'REPLACE_ONLY_MAIN', 'Only a main reviewer replaces anyone', 'programmes'] };
        if (seen.has(item.code)) return { error: [400, 'DUPLICATE_PROGRAMME', 'A programme can be chosen once', 'programmes'] };
        seen.add(item.code);
    }
    return { list: list.map((item) => ({ code: item.code, role: item.role, replace: item.replace === true })) };
};

/**
 * A person's link to a programme ends (inside a transaction, programme locked). Someone left with
 * no current programme is no longer a reviewer: deactivated, like a removed reviewer, and admins
 * acting as them stop. handOverTo: their open assigned applications there go to this person (a
 * swap); otherwise they become shared. Returns { moved, deactivated }.
 */
const endLinkAndRetire = async (client, { linkId, userId, programmeId, handOverTo = null }) => {
    const moved = await endLink(client, { linkId, userId, programmeId, handOverTo });
    const left = (await client.query('SELECT 1 FROM staff_programmes WHERE user_id = $1 AND ended_at IS NULL LIMIT 1', [userId])).rows.length;
    if (left) return { moved, deactivated: false };
    await client.query('UPDATE users SET deactivated_at = now() WHERE id = $1 AND deactivated_at IS NULL', [userId]);
    await client.query('UPDATE acting_sessions SET ended_at = now() WHERE person_id = $1 AND ended_at IS NULL', [userId]);
    return { moved, deactivated: true };
};

// The programme rows behind a list of codes, or null when one is unknown
const programmesByCode = async (db, codes) => {
    if (codes.length === 0) return [];
    const { rows } = await db.query('SELECT id, code, name_en, name_hu, name_de FROM programmes WHERE code = ANY($1)', [codes]);
    return rows.length === codes.length ? codes.map((code) => rows.find((r) => r.code === code)) : null;
};

// A database refusal that means "this programme already has a main reviewer" (two changes at once)
const isSecondMain = (err) => err.code === '23505' && err.constraint === 'staff_programmes_one_main';

// ---------------------------------------------------------------------------------------------
// Superadmin: invite, list, resend, cancel
// ---------------------------------------------------------------------------------------------

/**
 * POST /api/users/invites { email, role, programmes?: [{ code, role: main|extra, replace? }], language? }
 *   (or the short form programme_code + replace?: one programme as its main reviewer)
 * role: reviewer (needs at least one programme) or superadmin (no programme, no replace).
 * language: of the email (hu, en, de; default hu). The link is also returned, for the superadmin
 * only, while emails go to Mailtrap.
 */
router.post('/users/invites', verifyToken, requireRole('superadmin'), async (req, res) => {
    const body = req.body || {};
    const { email, role, programme_code: programmeCode, programmes: programmeList, replace, language } = body;
    const lowerEmail = typeof email === 'string' ? normalizeEmail(email) : '';
    if (!isValidInviteEmail(lowerEmail)) {
        return sendError(res, 400, 'INVALID_EMAIL', 'This is not a valid email address', { field: 'email' });
    }
    if (!INVITE_ROLES.includes(role)) {
        return sendError(res, 400, 'INVALID_ROLE', 'role must be reviewer or superadmin', { field: 'role' });
    }
    if (role === 'superadmin' && ((programmeCode !== undefined && programmeCode !== null && programmeCode !== '') || replace === true
        || (Array.isArray(programmeList) && programmeList.length > 0))) {
        return sendError(res, 400, 'PROGRAMME_ONLY_FOR_REVIEWERS', 'An admin invite has no programme', { field: 'programme_code' });
    }
    const choices = role === 'reviewer' ? readProgrammeChoices(body) : { list: [] };
    if (choices.error) {
        const [status, code, message, field] = choices.error;
        return sendError(res, status, code, message, { field });
    }
    if (role === 'reviewer' && choices.list.length === 0) {
        return sendError(res, 400, 'INVALID_PROGRAMME', 'Choose at least one study programme', { field: 'programme_code' });
    }
    if (language !== undefined && !['hu', 'en', 'de'].includes(language)) {
        return sendError(res, 400, 'UNSUPPORTED_LANGUAGE', 'Unsupported language', { field: 'language' });
    }

    try {
        const result = await inTransaction(async (client) => {
            const found = await programmesByCode(client, choices.list.map((c) => c.code));
            if (!found) return { error: [400, 'INVALID_PROGRAMME', 'Unknown study programme', 'programme_code'] };
            const programmes = choices.list.map((c, i) => ({ ...found[i], role: c.role, replace: c.replace }));

            const address = await checkInviteAddress(client, lowerEmail, role);
            if (address.error) return { error: [...address.error, 'email'] };

            // A main reviewer for a programme that has one only as a swap (replace: true).
            // An extra reviewer never replaces anyone.
            for (const programme of programmes) {
                if (programme.role === 'main' && !programme.replace && await mainReviewerOf(client, programme.id)) {
                    return { error: [409, 'PROGRAMME_HAS_REVIEWER', `${programme.code} already has a main reviewer (choose "replace" to swap them when the invite is accepted)`, 'programme_code'] };
                }
            }

            const created = await createInvite(client, { email: lowerEmail, role, programmes, language, invitedBy: req.actor.id });
            return { ...created, programmes };
        });
        if (result.error) {
            const [status, code, message, field] = result.error;
            return sendError(res, status, code, message, { field });
        }

        res.status(201).json({ success: true, invite: await readInvite(result.id), link: inviteLink(result.token) });
        sendInviteEmail({ email: lowerEmail, language, role, programmes: result.programmes, token: result.token });
    } catch (err) {
        // Two invites for the same address at the same moment: the database lets only one stay open
        if (err.code === '23505' && err.constraint === 'staff_invites_one_open_per_email') {
            return sendError(res, 409, 'INVITE_ALREADY_OPEN', 'An invite for this email was just created');
        }
        console.error('❌ Invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not create the invite');
    }
});

// GET /api/users/invites[?status=sent|accepted|expired|cancelled]: every invite with its status, newest first
router.get('/users/invites', verifyToken, requireRole('superadmin'), async (req, res) => {
    const { status } = req.query;
    if (status !== undefined && !INVITE_STATUSES.includes(status)) {
        return sendError(res, 400, 'INVALID_STATUS', 'status must be sent, accepted, expired or cancelled', { field: 'status' });
    }
    try {
        const { rows } = await pool.query(
            `SELECT ${INVITE_COLUMNS} ${INVITE_FROM}
             WHERE $1::text IS NULL OR ${INVITE_STATUS_SQL} = $1
             ORDER BY i.created_at DESC, i.id DESC`,
            [status ?? null]
        );
        res.json({ success: true, invites: rows });
    } catch (err) {
        console.error('❌ List invites error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list the invites');
    }
});

// POST /api/users/invites/:id/resend: a new link valid for another 7 days; the old link stops working.
// Only for invites that are sent or expired (not accepted, not cancelled).
router.post('/users/invites/:id/resend', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    const token = newToken();
    try {
        const { rows } = await pool.query(
            `UPDATE staff_invites i SET token_hash = $2, expires_at = now() + make_interval(days => $3)
             WHERE i.id = $1 AND ${OPEN_INVITE} RETURNING i.id, i.email, i.role, i.language`,
            [id, hashToken(token), INVITE_DAYS]
        );
        if (rows.length === 0) return sendError(res, 404, 'INVITE_NOT_FOUND', 'Invite not found (or already accepted or cancelled)');

        const invite = await readInvite(id);
        res.json({ success: true, invite, link: inviteLink(token) });
        const { email, role, language } = rows[0];
        sendInviteEmail({ email, language, role, programmes: invite.programmes, token });
    } catch (err) {
        console.error('❌ Resend invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not resend the invite');
    }
});

// DELETE /api/users/invites/:id: cancels a sent or expired invite (its link stops working)
router.delete('/users/invites/:id', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    try {
        const { rowCount } = await pool.query(`UPDATE staff_invites i SET cancelled_at = now() WHERE i.id = $1 AND ${OPEN_INVITE}`, [id]);
        if (rowCount === 0) return sendError(res, 404, 'INVITE_NOT_FOUND', 'Invite not found (or already accepted or cancelled)');
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Cancel invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not cancel the invite');
    }
});

// ---------------------------------------------------------------------------------------------
// Superadmin: the staff list, removing a reviewer, deactivating an admin
// ---------------------------------------------------------------------------------------------

// A person's programme links as JSON (alias u = users): current ones, or (ended = true) the ones
// that ended, newest first, one per programme
const linksSql = (ended) => `COALESCE((
    SELECT json_agg(json_build_object('code', x.code, 'name_en', x.name_en, 'name_hu', x.name_hu, 'name_de', x.name_de,
                                      'role', x.role, 'can_assist', x.can_assist) ORDER BY x.code)
    FROM (SELECT DISTINCT ON (sp.programme_id) p.code, p.name_en, p.name_hu, p.name_de, sp.role, sp.can_assist
          FROM staff_programmes sp JOIN programmes p ON p.id = sp.programme_id
          WHERE sp.user_id = u.id AND sp.ended_at IS ${ended ? 'NOT NULL' : 'NULL'}
          ORDER BY sp.programme_id, sp.ended_at DESC NULLS FIRST, sp.id DESC) x), '[]')`;

// GET /api/users/staff: every reviewer and admin, active or deactivated. A reviewer's programmes:
// programmes (current links: role main or extra, and can_assist), and for a deactivated reviewer
// past_programmes (the links that ended). is_self marks the logged-in admin (who can't deactivate themselves).
router.get('/users/staff', verifyToken, requireRole('superadmin'), async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT u.id, u.name, u.email, u.role, u.deactivated_at, u.id = $1 AS is_self,
                    ${linksSql(false)} AS programmes,
                    CASE WHEN u.deactivated_at IS NOT NULL THEN ${linksSql(true)} ELSE '[]' END AS past_programmes
             FROM users u
             WHERE u.role IN ('reviewer', 'superadmin')
             ORDER BY u.role DESC, (u.deactivated_at IS NOT NULL), u.name`,
            [req.actor.id]
        );
        res.json({ success: true, staff: rows });
    } catch (err) {
        console.error('❌ Staff list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list the staff');
    }
});

/**
 * PUT /api/users/:id/remove-reviewer: ends a reviewer's access. The account stays (role
 * reviewer), so their name stays on their decisions; deactivated_at is set and verifyToken
 * refuses them from the next request on. Every programme link ends (kept for history), and their
 * open applications assigned to them become shared again. Removing an already removed reviewer
 * changes nothing. A reviewer can't reach this route (superadmin only), so nobody removes themselves.
 */
router.put('/users/:id/remove-reviewer', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    try {
        const result = await inTransaction(async (client) => {
            const user = (await client.query('SELECT id, role, deactivated_at FROM users WHERE id = $1', [id])).rows[0];
            if (!user) return { error: [404, 'USER_NOT_FOUND', 'User not found'] };
            if (user.role !== 'reviewer') return { error: [400, 'NOT_A_REVIEWER', 'This user is not a reviewer'] };
            if (user.deactivated_at) return { alreadyRemoved: true, unassigned: 0 };

            const links = (await client.query('SELECT id, programme_id, role FROM staff_programmes WHERE user_id = $1 AND ended_at IS NULL', [id])).rows;
            await lockProgrammes(client, links.map((l) => l.programme_id));
            await client.query('UPDATE users SET deactivated_at = now() WHERE id = $1 AND deactivated_at IS NULL', [id]);
            let unassigned = 0;
            for (const link of links) unassigned += await endLink(client, { linkId: link.id, userId: id, programmeId: link.programme_id });
            // Admins acting as this reviewer: their sessions end too
            await client.query('UPDATE acting_sessions SET ended_at = now() WHERE person_id = $1 AND ended_at IS NULL', [id]);
            return { alreadyRemoved: false, unassigned, lostMain: links.filter((l) => l.role === 'main').map((l) => l.programme_id) };
        });
        if (result.error) {
            const [status, code, message] = result.error;
            return sendError(res, status, code, message);
        }
        const { lostMain = [], ...answer } = result;
        res.json({ success: true, ...answer });
        notifyAdminsNoMainReviewer(lostMain); // a main reviewer left while extra reviewers remain: the admins choose
    } catch (err) {
        console.error('❌ Remove reviewer error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not remove the reviewer');
    }
});

/**
 * PUT /api/users/:id/deactivate-admin: ends an admin's access (the account and name stay).
 * Refused for yourself and for the last active admin. All active admin rows are locked first, so
 * two admins deactivating each other at the same moment can't leave nobody: the second one finds
 * only one active admin left and is refused.
 */
router.put('/users/:id/deactivate-admin', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    if (id === req.actor.id) return sendError(res, 400, 'CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
    try {
        const result = await inTransaction(async (client) => {
            const active = (await client.query(
                "SELECT id FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL ORDER BY id FOR UPDATE"
            )).rows.map((row) => row.id);
            const user = (await client.query('SELECT id, role, deactivated_at FROM users WHERE id = $1', [id])).rows[0];
            if (!user) return { error: [404, 'USER_NOT_FOUND', 'User not found'] };
            if (user.role !== 'superadmin') return { error: [400, 'NOT_AN_ADMIN', 'This user is not an admin'] };
            if (user.deactivated_at) return { alreadyDeactivated: true };
            if (!active.includes(req.actor.id) || active.length <= 1) {
                return { error: [409, 'LAST_ADMIN', 'The last active admin cannot be deactivated'] };
            }

            await client.query('UPDATE users SET deactivated_at = now() WHERE id = $1', [id]);
            // Their acting sessions end at once (verifyToken refuses them anyway)
            await client.query('UPDATE acting_sessions SET ended_at = now() WHERE admin_id = $1 AND ended_at IS NULL', [id]);
            return { alreadyDeactivated: false };
        });
        if (result.error) {
            const [status, code, message] = result.error;
            return sendError(res, status, code, message);
        }
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Deactivate admin error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not deactivate the admin');
    }
});

// ---------------------------------------------------------------------------------------------
// Superadmin: an active reviewer's programmes (no invite needed: the account exists)
// ---------------------------------------------------------------------------------------------

// An active reviewer, or an error
const activeReviewer = async (client, id) => {
    const user = (await client.query('SELECT id, role, deactivated_at FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!user) return { error: [404, 'USER_NOT_FOUND', 'User not found'] };
    if (user.role !== 'reviewer') return { error: [400, 'NOT_A_REVIEWER', 'This user is not a reviewer'] };
    if (user.deactivated_at) return { error: [409, 'REVIEWER_DEACTIVATED', 'This reviewer is deactivated: invite them again'] };
    return { user };
};

/**
 * POST /api/users/:id/programmes { programme_code, role: main|extra, replace? }: links an active
 * reviewer to a programme, or gives them another role in one (the old link ends, a new one
 * starts; their assigned applications there stay theirs). Main for a programme that has a main
 * reviewer: refused (PROGRAMME_HAS_REVIEWER) unless replace, which swaps that person out now (as
 * accepting an invite does). An extra reviewer starts on standby (can_assist off); becoming the
 * main reviewer turns assisting off, since a main reviewer sees everything anyway.
 */
router.post('/users/:id/programmes', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    const { programme_code: code, role, replace } = req.body || {};
    const choices = readProgrammeChoices({ programmes: [{ code, role, replace }] });
    if (choices.error) {
        const [status, errorCode, message, field] = choices.error;
        return sendError(res, status, errorCode, message, { field: field === 'programmes' ? 'programme_code' : field });
    }
    const [choice] = choices.list;
    try {
        const result = await inTransaction(async (client) => {
            const [programme] = (await programmesByCode(client, [choice.code])) || [];
            if (!programme) return { error: [400, 'INVALID_PROGRAMME', 'Unknown study programme', 'programme_code'] };
            await lockProgrammes(client, [programme.id]);
            const found = await activeReviewer(client, id);
            if (found.error) return found;

            const current = (await client.query(
                'SELECT id, role FROM staff_programmes WHERE user_id = $1 AND programme_id = $2 AND ended_at IS NULL', [id, programme.id]
            )).rows[0];
            if (current && current.role === choice.role) return { error: [409, 'ALREADY_LINKED', 'This reviewer already has this role in this programme', 'programme_code'] };

            let swapped = null;
            let moved = 0;
            if (choice.role === 'main') {
                const main = await mainReviewerOf(client, programme.id, { lock: true });
                if (main && main.id !== id) {
                    if (!choice.replace) return { error: [409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a main reviewer (choose "replace" to swap them)', 'programme_code'] };
                    moved = (await endLinkAndRetire(client, { linkId: main.link_id, userId: main.id, programmeId: programme.id, handOverTo: id })).moved;
                    swapped = main.id;
                }
            }
            // A role change: the old link ends, the person keeps their assigned applications there
            if (current) await endLink(client, { linkId: current.id, userId: id, programmeId: programme.id, handOverTo: id });
            await client.query(
                'INSERT INTO staff_programmes (user_id, programme_id, role, created_by) VALUES ($1, $2, $3, $4)',
                [id, programme.id, choice.role, req.actor.id]
            );
            // The main reviewer became an extra one: the programme has no main reviewer now
            return { changed: Boolean(current), swapped, moved, lostMain: current && current.role === 'main' ? [programme.id] : [] };
        });
        if (result.error) {
            const [status, code2, message, field] = result.error;
            return sendError(res, status, code2, message, { field });
        }
        const { lostMain = [], ...answer } = result;
        res.status(result.changed ? 200 : 201).json({ success: true, ...answer });
        notifyAdminsNoMainReviewer(lostMain);
    } catch (err) {
        if (isSecondMain(err)) return sendError(res, 409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a main reviewer');
        console.error('❌ Add programme error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not change the reviewer\'s programmes');
    }
});

/**
 * DELETE /api/users/:id/programmes/:code: ends an active reviewer's link to one programme. Their
 * open applications assigned to them there become shared again. Their last programme can't be
 * removed this way (LAST_PROGRAMME): remove the reviewer instead.
 */
router.delete('/users/:id/programmes/:code', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    try {
        const result = await inTransaction(async (client) => {
            const [programme] = (await programmesByCode(client, [String(req.params.code)])) || [];
            if (!programme) return { error: [404, 'LINK_NOT_FOUND', 'This reviewer is not linked to this programme'] };
            await lockProgrammes(client, [programme.id]);
            const found = await activeReviewer(client, id);
            if (found.error) return found;
            const links = (await client.query('SELECT id, programme_id, role FROM staff_programmes WHERE user_id = $1 AND ended_at IS NULL', [id])).rows;
            const link = links.find((l) => l.programme_id === programme.id);
            if (!link) return { error: [404, 'LINK_NOT_FOUND', 'This reviewer is not linked to this programme'] };
            if (links.length === 1) return { error: [409, 'LAST_PROGRAMME', 'This is the reviewer\'s only programme: remove the reviewer instead'] };
            const unassigned = await endLink(client, { linkId: link.id, userId: id, programmeId: programme.id });
            return { unassigned, lostMain: link.role === 'main' ? [programme.id] : [] };
        });
        if (result.error) {
            const [status, code, message] = result.error;
            return sendError(res, status, code, message);
        }
        const { lostMain = [], ...answer } = result;
        res.json({ success: true, ...answer });
        notifyAdminsNoMainReviewer(lostMain);
    } catch (err) {
        console.error('❌ Remove programme error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not change the reviewer\'s programmes');
    }
});

// ---------------------------------------------------------------------------------------------
// Public: the accept page (frontend /invite/:token)
// ---------------------------------------------------------------------------------------------

// The invite behind a link, or an error [status, code, message]. Used, cancelled and unknown
// links all get the same answer.
const findInvite = async (db, token, { lock = false } = {}) => {
    const invite = (await db.query(
        `SELECT i.id, i.email, i.role, i.language, i.invited_by, i.accepted_at, i.cancelled_at, i.expires_at <= now() AS expired
         FROM staff_invites i
         WHERE i.token_hash = $1${lock ? ' FOR UPDATE OF i' : ''}`,
        [hashToken(token)]
    )).rows[0];
    if (invite) {
        invite.programmes = (await db.query(
            `SELECT ip.programme_id, ip.role, ip.replace_main, p.code, p.name_en, p.name_hu, p.name_de
             FROM staff_invite_programmes ip JOIN programmes p ON p.id = ip.programme_id
             WHERE ip.invite_id = $1 ORDER BY ip.programme_id`,
            [invite.id]
        )).rows;
    }
    if (!invite || invite.accepted_at || invite.cancelled_at) return { error: [410, 'INVITE_INVALID', 'This invitation link is not valid'] };
    if (invite.expired) return { error: [410, 'INVITE_EXPIRED', 'This invitation has expired. Please ask the administrator for a new one.'] };
    return { invite };
};

// The account with the invite's address, if any
const accountFor = async (db, email, { lock = false } = {}) => (await db.query(
    `SELECT id, name, role, deactivated_at FROM users WHERE email = $1${lock ? ' FOR UPDATE' : ''}`, [email]
)).rows[0] || null;

// Only a deactivated account of the invite's role can be reactivated by it
const canReactivate = (account, invite) => !!account.deactivated_at && account.role === invite.role;

// GET /api/invites/:token: what the accept page shows (email, role, programmes with the role in each, and the existing
// name when it reactivates a deactivated account: that name can't be changed)
router.get('/invites/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { invite, error } = await findInvite(pool, req.params.token);
        if (error) return sendError(res, error[0], error[1], error[2]);
        const account = await accountFor(pool, invite.email);
        if (account && !canReactivate(account, invite)) return sendError(res, 410, 'INVITE_INVALID', 'This invitation link is not valid');

        res.json({
            success: true,
            invite: {
                email: invite.email,
                role: invite.role,
                programmes: invite.programmes.map(({ code, name_en, name_hu, name_de, role }) => ({ code, name_en, name_hu, name_de, role })),
                existingName: account ? account.name : null,
            },
        });
    } catch (err) {
        console.error('❌ Read invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not read the invitation');
    }
});

// POST /api/invites/:token/accept { name, password }: creates (or reactivates) the account,
// verified, with the invite's role (and programme links). name is ignored when reactivating.
router.post('/invites/:token/accept', async (req, res) => {
    // Same per-IP limit as registration: this creates accounts too
    try {
        if (!(await takeSlot('invite_accept_ip', clientIp(req), LIMITS.registerPerIp))) {
            return sendError(res, 429, 'TOO_MANY_REQUESTS', 'Too many attempts, please try again later');
        }
    } catch (err) {
        console.error('Invite accept rate limit error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not accept the invitation');
    }

    const { name, password } = req.body || {};
    const passwordProblem = checkPassword(password);
    if (passwordProblem) return sendValidationErrors(res, [{ field: 'password', ...passwordProblem }]);
    const cleanName = typeof name === 'string' ? name.trim() : '';

    try {
        const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
        const result = await inTransaction(async (client) => {
            const { invite, error } = await findInvite(client, req.params.token, { lock: true });
            if (error) return { error };
            const isReviewer = invite.role === 'reviewer';

            // Nobody else changes these programmes' reviewers while this runs (id order: utils/reviewers.js)
            if (isReviewer) await lockProgrammes(client, invite.programmes.map((p) => p.programme_id));
            const account = await accountFor(client, invite.email, { lock: true });
            if (account && !canReactivate(account, invite)) return { error: [409, 'EMAIL_TAKEN', 'This email already belongs to an active account'] };
            if (!account && (!cleanName || cleanName.length > MAX_NAME_LENGTH)) {
                return { error: [400, 'MISSING_FIELDS', 'Please enter your name', 'name'] };
            }

            // 1. Main roles: a programme with a main reviewer is refused, unless the invite swaps them
            const swaps = [];
            if (isReviewer) {
                for (const programme of invite.programmes.filter((p) => p.role === 'main')) {
                    const current = await mainReviewerOf(client, programme.programme_id, { lock: true });
                    if (!current || (account && current.id === account.id)) continue;
                    if (!programme.replace_main) {
                        return { error: [409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a reviewer. Please ask the administrator.'] };
                    }
                    swaps.push({ programmeId: programme.programme_id, current });
                }
            }

            // 2. The account: a new verified one, or the deactivated one back again (same id and
            //    name, new password). Staff never have users.programme_id (students only).
            let userId;
            if (account) {
                await client.query(
                    `UPDATE users SET password = $2, deactivated_at = NULL, is_verified = true,
                        verification_token = NULL, reset_password_token = NULL, reset_password_expires = NULL
                     WHERE id = $1`,
                    [account.id, hashedPassword]
                );
                userId = account.id;
            } else {
                const { rows } = await client.query(
                    `INSERT INTO users (name, email, password, role, is_verified, preferred_language)
                     VALUES ($1, $2, $3, $4, true, $5) RETURNING id`,
                    [cleanName, invite.email, hashedPassword, invite.role, normalizeLanguage(invite.language)]
                );
                userId = rows[0].id;
            }

            // 3. Swaps: the old main reviewer's link ends and their open applications assigned to
            //    them move to the new person (reply deadlines and the student's replies stay).
            //    Someone left with no programme is deactivated. Then the new links.
            let moved = 0;
            const replaced = [];
            for (const swap of swaps) {
                const result = await endLinkAndRetire(client, { linkId: swap.current.link_id, userId: swap.current.id, programmeId: swap.programmeId, handOverTo: userId });
                moved += result.moved;
                replaced.push(swap.current.id);
            }
            for (const programme of isReviewer ? invite.programmes : []) {
                await client.query(
                    'INSERT INTO staff_programmes (user_id, programme_id, role, created_by) VALUES ($1, $2, $3, $4)',
                    [userId, programme.programme_id, programme.role, invite.invited_by]
                );
            }

            await client.query('UPDATE staff_invites SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [invite.id, userId]);
            return { reactivated: !!account, replaced, moved, role: invite.role, links: invite.programmes.length };
        });
        if (result.error) {
            const [status, code, message, field] = result.error;
            return sendError(res, status, code, message, { field });
        }
        res.json({ success: true, reactivated: result.reactivated, role: result.role });
        console.log(`👤 ${result.role} invite accepted${result.role === 'reviewer' ? `: ${result.links} programme(s), ${result.moved} open application(s) handed over` : ''}${result.replaced.length ? `, main reviewer(s) #${result.replaced.join(', #')} swapped out` : ''}`);
    } catch (err) {
        // Two acceptances racing for one programme: the database keeps one main reviewer
        if (isSecondMain(err)) {
            return sendError(res, 409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a reviewer. Please ask the administrator.');
        }
        if (err.code === '23505' && err.constraint === 'users_email_key') {
            return sendError(res, 409, 'EMAIL_TAKEN', 'This email already belongs to an active account');
        }
        console.error('❌ Accept invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not accept the invitation');
    }
});

module.exports = router;
