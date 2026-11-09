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
const { OPEN_STATUSES, lockProgramme, activeReviewerOf } = require('../utils/reviewers');
const {
    INVITE_DAYS, INVITE_ROLES, INVITE_STATUSES, INVITE_STATUS_SQL, OPEN_INVITE,
    newToken, hashToken, inviteLink, isValidInviteEmail, sendInviteEmail, checkInviteAddress, createInvite,
} = require('../utils/staffInvites');
const { sendValidationErrors } = sendError;

// Staff access (reviewer Group 2, admin round Group 2). Reviewers and admins never register:
// the superadmin invites them. Registration only ever creates students (routes/auth.js).
//
// Accepting a reviewer invite is where a programme's reviewer changes (one transaction):
//   1. the programme's current reviewer is deactivated (only with replace; otherwise refused),
//   2. the new reviewer is created, or a deactivated reviewer with this email is reactivated,
//   3. the programme's open (pending, needs_info) applications move to the new reviewer.
// Until then the current reviewer keeps full access. Decided applications never move.
// An admin invite creates (or reactivates) an admin; it has no programme.

const MAX_NAME_LENGTH = 100; // users.name

// What the superadmin sees of an invite (never the token or its hash)
const INVITE_COLUMNS = `
    i.id, i.email, i.role, i.language, i.replace_reviewer AS replace, i.created_at, i.expires_at,
    i.accepted_at, i.cancelled_at, ${INVITE_STATUS_SQL} AS status,
    p.code AS programme_code, p.name_en, p.name_hu, p.name_de, inviter.name AS invited_by_name`;
const INVITE_FROM = `
    FROM staff_invites i
    LEFT JOIN programmes p ON p.id = i.programme_id
    LEFT JOIN users inviter ON inviter.id = i.invited_by`;

const inviteForAdmin = ({ programme_code: code, name_en, name_hu, name_de, ...invite }) => (
    { ...invite, programme: code ? { code, name_en, name_hu, name_de } : null }
);
const readInvite = async (id) => inviteForAdmin((await pool.query(`SELECT ${INVITE_COLUMNS} ${INVITE_FROM} WHERE i.id = $1`, [id])).rows[0]);

// ---------------------------------------------------------------------------------------------
// Superadmin: invite, list, resend, cancel
// ---------------------------------------------------------------------------------------------

/**
 * POST /api/users/invites { email, role, programme_code?, replace?, language? }
 * role: reviewer (needs programme_code) or superadmin (no programme, no replace).
 * language: of the email (hu, en, de; default hu). The link is also returned, for the superadmin
 * only, while emails go to Mailtrap.
 */
router.post('/users/invites', verifyToken, requireRole('superadmin'), async (req, res) => {
    const { email, role, programme_code: programmeCode, replace, language } = req.body || {};
    const lowerEmail = typeof email === 'string' ? normalizeEmail(email) : '';
    if (!isValidInviteEmail(lowerEmail)) {
        return sendError(res, 400, 'INVALID_EMAIL', 'This is not a valid email address', { field: 'email' });
    }
    if (!INVITE_ROLES.includes(role)) {
        return sendError(res, 400, 'INVALID_ROLE', 'role must be reviewer or superadmin', { field: 'role' });
    }
    if (replace !== undefined && typeof replace !== 'boolean') {
        return sendError(res, 400, 'INVALID_FIELD', 'replace must be true or false', { field: 'replace' });
    }
    if (role === 'superadmin' && ((programmeCode !== undefined && programmeCode !== null && programmeCode !== '') || replace === true)) {
        return sendError(res, 400, 'PROGRAMME_ONLY_FOR_REVIEWERS', 'An admin invite has no programme', { field: 'programme_code' });
    }
    if (language !== undefined && !['hu', 'en', 'de'].includes(language)) {
        return sendError(res, 400, 'UNSUPPORTED_LANGUAGE', 'Unsupported language', { field: 'language' });
    }

    try {
        const result = await inTransaction(async (client) => {
            let programme = null;
            if (role === 'reviewer') {
                programme = typeof programmeCode === 'string'
                    ? (await client.query('SELECT id, code, name_en, name_hu, name_de FROM programmes WHERE code = $1', [programmeCode])).rows[0]
                    : null;
                if (!programme) return { error: [400, 'INVALID_PROGRAMME', 'Unknown study programme', 'programme_code'] };
            }

            const address = await checkInviteAddress(client, lowerEmail, role);
            if (address.error) return { error: [...address.error, 'email'] };

            // A second reviewer for a programme only as a swap (replace: true)
            if (programme && !replace && await activeReviewerOf(client, programme.id)) {
                return { error: [409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a reviewer (choose "replace" to swap them when the invite is accepted)', 'programme_code'] };
            }

            const created = await createInvite(client, {
                email: lowerEmail, role, programmeId: programme ? programme.id : null, replace, language, invitedBy: req.actor.id,
            });
            return { ...created, programme };
        });
        if (result.error) {
            const [status, code, message, field] = result.error;
            return sendError(res, status, code, message, { field });
        }

        res.status(201).json({ success: true, invite: await readInvite(result.id), link: inviteLink(result.token) });
        sendInviteEmail({ email: lowerEmail, language, role, programme: result.programme, token: result.token });
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
        res.json({ success: true, invites: rows.map(inviteForAdmin) });
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
        sendInviteEmail({ email, language, role, programme: invite.programme, token });
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

// GET /api/users/staff: every reviewer (with programme) and admin, active or deactivated.
// is_self marks the logged-in admin (who can't deactivate themselves).
router.get('/users/staff', verifyToken, requireRole('superadmin'), async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT u.id, u.name, u.email, u.role, u.deactivated_at, u.id = $1 AS is_self,
                    p.code AS programme_code, p.name_en, p.name_hu, p.name_de
             FROM users u LEFT JOIN programmes p ON p.id = u.programme_id AND u.role = 'reviewer'
             WHERE u.role IN ('reviewer', 'superadmin')
             ORDER BY u.role DESC, p.code NULLS FIRST, (u.deactivated_at IS NOT NULL), u.name`,
            [req.actor.id]
        );
        res.json({ success: true, staff: rows.map(inviteForAdmin) });
    } catch (err) {
        console.error('❌ Staff list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list the staff');
    }
});

/**
 * PUT /api/users/:id/remove-reviewer: ends a reviewer's access. The account stays (role
 * reviewer, same programme), so their name stays on their decisions; deactivated_at is set and
 * verifyToken refuses them from the next request on. Their open applications have no reviewer
 * until a new one accepts an invite. Removing an already removed reviewer changes nothing.
 * A reviewer can't reach this route (superadmin only), so nobody removes themselves.
 */
router.put('/users/:id/remove-reviewer', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    try {
        const result = await inTransaction(async (client) => {
            const user = (await client.query('SELECT id, role, programme_id, deactivated_at FROM users WHERE id = $1', [id])).rows[0];
            if (!user) return { error: [404, 'USER_NOT_FOUND', 'User not found'] };
            if (user.role !== 'reviewer') return { error: [400, 'NOT_A_REVIEWER', 'This user is not a reviewer'] };
            if (user.deactivated_at) return { alreadyRemoved: true, unassigned: 0 };

            await lockProgramme(client, user.programme_id);
            await client.query('UPDATE users SET deactivated_at = now() WHERE id = $1 AND deactivated_at IS NULL', [id]);
            const { rowCount } = await client.query(
                'UPDATE applications SET assigned_reviewer_id = NULL WHERE assigned_reviewer_id = $1 AND status = ANY($2)',
                [id, OPEN_STATUSES]
            );
            // Admins acting as this reviewer: their sessions end too
            await client.query('UPDATE acting_sessions SET ended_at = now() WHERE person_id = $1 AND ended_at IS NULL', [id]);
            return { alreadyRemoved: false, unassigned: rowCount };
        });
        if (result.error) {
            const [status, code, message] = result.error;
            return sendError(res, status, code, message);
        }
        res.json({ success: true, ...result });
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
// Public: the accept page (frontend /invite/:token)
// ---------------------------------------------------------------------------------------------

// The invite behind a link, or an error [status, code, message]. Used, cancelled and unknown
// links all get the same answer.
const findInvite = async (db, token, { lock = false } = {}) => {
    const invite = (await db.query(
        `SELECT i.id, i.email, i.role, i.programme_id, i.replace_reviewer, i.language, i.accepted_at, i.cancelled_at, i.expires_at <= now() AS expired,
                p.code AS programme_code, p.name_en, p.name_hu, p.name_de
         FROM staff_invites i LEFT JOIN programmes p ON p.id = i.programme_id
         WHERE i.token_hash = $1${lock ? ' FOR UPDATE OF i' : ''}`,
        [hashToken(token)]
    )).rows[0];
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

// GET /api/invites/:token: what the accept page shows (email, role, programme, and the existing
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
                programme: invite.programme_code
                    ? { code: invite.programme_code, name_en: invite.name_en, name_hu: invite.name_hu, name_de: invite.name_de }
                    : null,
                existingName: account ? account.name : null,
            },
        });
    } catch (err) {
        console.error('❌ Read invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not read the invitation');
    }
});

// POST /api/invites/:token/accept { name, password }: creates (or reactivates) the account,
// verified, with the invite's role (and programme). name is ignored when reactivating.
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

            // Nobody else changes this programme's reviewer while this runs (utils/reviewers.js)
            if (isReviewer) await lockProgramme(client, invite.programme_id);
            const account = await accountFor(client, invite.email, { lock: true });
            if (account && !canReactivate(account, invite)) return { error: [409, 'EMAIL_TAKEN', 'This email already belongs to an active account'] };
            if (!account && (!cleanName || cleanName.length > MAX_NAME_LENGTH)) {
                return { error: [400, 'MISSING_FIELDS', 'Please enter your name', 'name'] };
            }

            // 1. Reviewers: the programme's current reviewer steps down first (one active reviewer per programme)
            let replaced = null;
            if (isReviewer) {
                const current = await activeReviewerOf(client, invite.programme_id, { lock: true });
                if (current) {
                    if (!invite.replace_reviewer) {
                        return { error: [409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a reviewer. Please ask the administrator.'] };
                    }
                    await client.query('UPDATE users SET deactivated_at = now() WHERE id = $1', [current.id]);
                    await client.query('UPDATE acting_sessions SET ended_at = now() WHERE person_id = $1 AND ended_at IS NULL', [current.id]);
                    replaced = current.id;
                }
            }

            // 2. The account: a new verified one, or the deactivated one back again (same id and
            //    name, new password; a reviewer gets the programme of the new invite)
            let userId;
            if (account) {
                await client.query(
                    `UPDATE users SET password = $2, programme_id = CASE WHEN $3::int IS NULL THEN programme_id ELSE $3::int END,
                        deactivated_at = NULL, is_verified = true,
                        verification_token = NULL, reset_password_token = NULL, reset_password_expires = NULL
                     WHERE id = $1`,
                    [account.id, hashedPassword, invite.programme_id]
                );
                userId = account.id;
            } else {
                const { rows } = await client.query(
                    `INSERT INTO users (name, email, password, role, is_verified, programme_id, preferred_language)
                     VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING id`,
                    [cleanName, invite.email, hashedPassword, invite.role, invite.programme_id, normalizeLanguage(invite.language)]
                );
                userId = rows[0].id;
            }

            // 3. Reviewers: the programme's open applications move to the new reviewer. Only the
            //    assignment changes: reply deadlines and everything about the student's reply stay.
            let moved = 0;
            if (isReviewer) {
                moved = (await client.query(
                    'UPDATE applications SET assigned_reviewer_id = $1 WHERE programme_id = $2 AND status = ANY($3)',
                    [userId, invite.programme_id, OPEN_STATUSES]
                )).rowCount;
            }

            await client.query('UPDATE staff_invites SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [invite.id, userId]);
            return { reactivated: !!account, replaced, moved, role: invite.role };
        });
        if (result.error) {
            const [status, code, message, field] = result.error;
            return sendError(res, status, code, message, { field });
        }
        res.json({ success: true, reactivated: result.reactivated, role: result.role });
        console.log(`👤 ${result.role} invite accepted${result.role === 'reviewer' ? `: ${result.moved} open application(s) assigned` : ''}${result.replaced ? `, reviewer #${result.replaced} deactivated` : ''}`);
    } catch (err) {
        // Two acceptances racing for one programme: the database keeps one active reviewer
        if (err.code === '23505' && err.constraint === 'users_one_active_reviewer_per_programme') {
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
