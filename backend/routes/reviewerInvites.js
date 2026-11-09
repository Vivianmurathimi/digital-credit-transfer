const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { requireIdParam } = require('../utils/validate');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const sendEmail = require('../utils/sendEmail');
const { buildAccountEmail, normalizeLanguage } = require('../utils/emailTemplates');
const { FRONTEND_URL } = require('../config/urls');
const { LIMITS, takeSlot, normalizeEmail, clientIp } = require('../utils/rateLimit');
const { checkPassword } = require('../utils/passwordRules');
const { OPEN_STATUSES, lockProgramme, activeReviewerOf } = require('../utils/reviewers');
const { sendValidationErrors } = sendError;

// Reviewer access (reviewer Group 2). Reviewers don't register: the superadmin invites them by
// email for one programme. The invite link is valid for 7 days and works once. Only a SHA-256
// hash of its token is stored, so the database never holds a working link.
//
// Accepting the invite is where a programme's reviewer changes (one transaction):
//   1. the programme's current reviewer is deactivated (only with replace; otherwise refused),
//   2. the new reviewer is created, or a deactivated reviewer with this email is reactivated,
//   3. the programme's open (pending, needs_info) applications move to the new reviewer.
// Until then the current reviewer keeps full access. Decided applications never move.

const INVITE_DAYS = 7;
const MAX_EMAIL_LENGTH = 100; // users.email
const MAX_NAME_LENGTH = 100; // users.name
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const newToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const inviteLink = (token) => `${FRONTEND_URL}/invite/${token}`;

const programmeNameIn = (programme, language) => programme[`name_${language}`] || programme.name_en;

// Sends the invite email; never throws (call without await, after the reply)
const sendInviteEmail = async ({ email, language, programme, token }) => {
    try {
        const lang = normalizeLanguage(language);
        const { subject, html } = buildAccountEmail('reviewerInvite', lang, { url: inviteLink(token), programme: programmeNameIn(programme, lang) });
        await sendEmail({ email, subject, html });
    } catch (err) {
        console.error(`❌ Reviewer invite email to ${email} failed:`, err.message);
    }
};

// What the superadmin sees of an invite (never the token or its hash)
const INVITE_COLUMNS = `
    i.id, i.email, i.language, i.replace_reviewer AS replace, i.created_at, i.expires_at, i.expires_at <= now() AS expired,
    p.code AS programme_code, p.name_en, p.name_hu, p.name_de, inviter.name AS invited_by_name`;
const INVITE_FROM = `
    FROM reviewer_invites i
    JOIN programmes p ON p.id = i.programme_id
    LEFT JOIN users inviter ON inviter.id = i.invited_by`;
const OPEN_INVITE = 'i.accepted_at IS NULL AND i.cancelled_at IS NULL';

const inviteForAdmin = ({ programme_code: code, name_en, name_hu, name_de, ...invite }) => (
    { ...invite, programme: { code, name_en, name_hu, name_de } }
);


// ---------------------------------------------------------------------------------------------
// Superadmin: invite, list, resend, cancel, remove a reviewer
// ---------------------------------------------------------------------------------------------

/**
 * POST /api/users/invite-reviewer { email, programme_code, replace?, language? }
 * language: of the email (hu, en, de; default hu). The link is also returned, for the
 * superadmin only, while emails go to Mailtrap.
 */
router.post('/users/invite-reviewer', verifyToken, requireRole('superadmin'), async (req, res) => {
    const { email, programme_code: programmeCode, replace, language } = req.body;
    const lowerEmail = typeof email === 'string' ? normalizeEmail(email) : '';
    if (!lowerEmail || lowerEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(lowerEmail)) {
        return sendError(res, 400, 'INVALID_EMAIL', 'This is not a valid email address', { field: 'email' });
    }
    if (replace !== undefined && typeof replace !== 'boolean') {
        return sendError(res, 400, 'INVALID_FIELD', 'replace must be true or false', { field: 'replace' });
    }
    const lang = normalizeLanguage(language);
    const token = newToken();

    try {
        const result = await inTransaction(async (client) => {
            const programme = typeof programmeCode === 'string'
                ? (await client.query('SELECT id, code, name_en, name_hu, name_de FROM programmes WHERE code = $1', [programmeCode])).rows[0]
                : null;
            if (!programme) return { error: [400, 'INVALID_PROGRAMME', 'Unknown study programme', 'programme_code'] };

            // Only a new address, or a removed reviewer's (accepting reactivates that account)
            const existing = (await client.query('SELECT role, reviewer_deactivated_at FROM users WHERE email = $1', [lowerEmail])).rows[0];
            if (existing && !(existing.role === 'reviewer' && existing.reviewer_deactivated_at)) {
                return { error: [409, 'EMAIL_TAKEN', 'This email already belongs to an account', 'email'] };
            }
            if (!replace && await activeReviewerOf(client, programme.id)) {
                return { error: [409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a reviewer (send replace: true to replace them when the invite is accepted)', 'programme_code'] };
            }

            // A new invite replaces an open one for the same address: its link stops working
            await client.query(
                'UPDATE reviewer_invites SET cancelled_at = now() WHERE email = $1 AND accepted_at IS NULL AND cancelled_at IS NULL',
                [lowerEmail]
            );
            const { rows } = await client.query(
                `INSERT INTO reviewer_invites (email, programme_id, replace_reviewer, language, token_hash, invited_by, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING id`,
                [lowerEmail, programme.id, replace === true, lang, hashToken(token), req.user.id, INVITE_DAYS]
            );
            return { id: rows[0].id, programme };
        });
        if (result.error) {
            const [status, code, message, field] = result.error;
            return sendError(res, status, code, message, { field });
        }

        const invite = (await pool.query(`SELECT ${INVITE_COLUMNS} ${INVITE_FROM} WHERE i.id = $1`, [result.id])).rows[0];
        res.status(201).json({ success: true, invite: inviteForAdmin(invite), link: inviteLink(token) });

        sendInviteEmail({ email: lowerEmail, language: lang, programme: result.programme, token });
    } catch (err) {
        // Two invites for the same address at the same moment: the database lets only one stay open
        if (err.code === '23505' && err.constraint === 'reviewer_invites_one_open_per_email') {
            return sendError(res, 409, 'INVITE_ALREADY_OPEN', 'An invite for this email was just created');
        }
        console.error('❌ Reviewer invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not create the invite');
    }
});

// GET /api/users/reviewer-invites: the open invites (not accepted, not cancelled), newest first.
// Expired ones are listed too (expired: true), so they can be resent.
router.get('/users/reviewer-invites', verifyToken, requireRole('superadmin'), async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT ${INVITE_COLUMNS} ${INVITE_FROM} WHERE ${OPEN_INVITE} ORDER BY i.created_at DESC, i.id DESC`);
        res.json({ success: true, invites: rows.map(inviteForAdmin) });
    } catch (err) {
        console.error('❌ List reviewer invites error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list the invites');
    }
});

// POST /api/users/reviewer-invites/:id/resend: a new link valid for another 7 days; the old link stops working
router.post('/users/reviewer-invites/:id/resend', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    const token = newToken();
    try {
        const { rows } = await pool.query(
            `UPDATE reviewer_invites i SET token_hash = $2, expires_at = now() + make_interval(days => $3)
             WHERE i.id = $1 AND ${OPEN_INVITE} RETURNING i.id, i.email, i.language, i.programme_id`,
            [id, hashToken(token), INVITE_DAYS]
        );
        if (rows.length === 0) return sendError(res, 404, 'INVITE_NOT_FOUND', 'Invite not found (or already accepted or cancelled)');

        const invite = (await pool.query(`SELECT ${INVITE_COLUMNS} ${INVITE_FROM} WHERE i.id = $1`, [id])).rows[0];
        res.json({ success: true, invite: inviteForAdmin(invite), link: inviteLink(token) });

        const { email, language } = rows[0];
        sendInviteEmail({ email, language, programme: { name_en: invite.name_en, name_hu: invite.name_hu, name_de: invite.name_de }, token });
    } catch (err) {
        console.error('❌ Resend reviewer invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not resend the invite');
    }
});

// DELETE /api/users/reviewer-invites/:id: cancels an open invite (its link stops working)
router.delete('/users/reviewer-invites/:id', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    try {
        const { rowCount } = await pool.query(`UPDATE reviewer_invites i SET cancelled_at = now() WHERE i.id = $1 AND ${OPEN_INVITE}`, [id]);
        if (rowCount === 0) return sendError(res, 404, 'INVITE_NOT_FOUND', 'Invite not found (or already accepted or cancelled)');
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Cancel reviewer invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not cancel the invite');
    }
});

/**
 * PUT /api/users/:id/remove-reviewer: ends a reviewer's access. The account stays (role
 * reviewer, same programme), so their name stays on their decisions; reviewer_deactivated_at
 * is set and verifyToken refuses them from the next request on. Their open applications have
 * no reviewer until a new one accepts an invite. Removing an already removed reviewer changes nothing.
 */
router.put('/users/:id/remove-reviewer', verifyToken, requireRole('superadmin'), requireIdParam('id'), async (req, res) => {
    const { id } = req.ids;
    try {
        const result = await inTransaction(async (client) => {
            const user = (await client.query('SELECT id, role, programme_id, reviewer_deactivated_at FROM users WHERE id = $1', [id])).rows[0];
            if (!user) return { error: [404, 'USER_NOT_FOUND', 'User not found'] };
            if (user.role !== 'reviewer') return { error: [400, 'NOT_A_REVIEWER', 'This user is not a reviewer'] };
            if (user.reviewer_deactivated_at) return { alreadyRemoved: true, unassigned: 0 };

            await lockProgramme(client, user.programme_id);
            await client.query('UPDATE users SET reviewer_deactivated_at = now() WHERE id = $1 AND reviewer_deactivated_at IS NULL', [id]);
            const { rowCount } = await client.query(
                'UPDATE applications SET assigned_reviewer_id = NULL WHERE assigned_reviewer_id = $1 AND status = ANY($2)',
                [id, OPEN_STATUSES]
            );
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

// ---------------------------------------------------------------------------------------------
// Public: the accept page (frontend /invite/:token)
// ---------------------------------------------------------------------------------------------

// The invite behind a link, or an error [status, code, message]. Used, cancelled and unknown
// links all get the same answer.
const findInvite = async (db, token, { lock = false } = {}) => {
    const invite = (await db.query(
        `SELECT i.id, i.email, i.programme_id, i.replace_reviewer, i.language, i.accepted_at, i.cancelled_at, i.expires_at <= now() AS expired,
                p.code AS programme_code, p.name_en, p.name_hu, p.name_de
         FROM reviewer_invites i JOIN programmes p ON p.id = i.programme_id
         WHERE i.token_hash = $1${lock ? ' FOR UPDATE OF i' : ''}`,
        [hashToken(token)]
    )).rows[0];
    if (!invite || invite.accepted_at || invite.cancelled_at) return { error: [410, 'INVITE_INVALID', 'This invitation link is not valid'] };
    if (invite.expired) return { error: [410, 'INVITE_EXPIRED', 'This invitation has expired. Please ask the administrator for a new one.'] };
    return { invite };
};

// The account the invite would reactivate (a removed reviewer with this email), if any
const accountFor = async (db, email, { lock = false } = {}) => (await db.query(
    `SELECT id, name, role, reviewer_deactivated_at FROM users WHERE email = $1${lock ? ' FOR UPDATE' : ''}`, [email]
)).rows[0] || null;

const isRemovedReviewer = (user) => user.role === 'reviewer' && !!user.reviewer_deactivated_at;

// GET /api/invites/:token: what the accept page shows (email, programme, and the existing name
// when it reactivates a removed reviewer: that name can't be changed)
router.get('/invites/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { invite, error } = await findInvite(pool, req.params.token);
        if (error) return sendError(res, error[0], error[1], error[2]);
        const account = await accountFor(pool, invite.email);
        if (account && !isRemovedReviewer(account)) return sendError(res, 410, 'INVITE_INVALID', 'This invitation link is not valid');

        res.json({
            success: true,
            invite: {
                email: invite.email,
                programme: { code: invite.programme_code, name_en: invite.name_en, name_hu: invite.name_hu, name_de: invite.name_de },
                existingName: account ? account.name : null,
            },
        });
    } catch (err) {
        console.error('❌ Read reviewer invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not read the invitation');
    }
});

// POST /api/invites/:token/accept { name, password }: creates (or reactivates) the reviewer
// account, verified, and makes it the programme's reviewer. name is ignored when reactivating.
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

    const { name, password } = req.body;
    const passwordProblem = checkPassword(password);
    if (passwordProblem) return sendValidationErrors(res, [{ field: 'password', ...passwordProblem }]);
    const cleanName = typeof name === 'string' ? name.trim() : '';

    try {
        const hashedPassword = await bcrypt.hash(password, await bcrypt.genSalt(10));
        const result = await inTransaction(async (client) => {
            const { invite, error } = await findInvite(client, req.params.token, { lock: true });
            if (error) return { error };

            // Nobody else changes this programme's reviewer while this runs (utils/reviewers.js)
            await lockProgramme(client, invite.programme_id);
            const account = await accountFor(client, invite.email, { lock: true });
            if (account && !isRemovedReviewer(account)) return { error: [409, 'EMAIL_TAKEN', 'This email already belongs to an account'] };
            if (!account && (!cleanName || cleanName.length > MAX_NAME_LENGTH)) {
                return { error: [400, 'MISSING_FIELDS', 'Please enter your name', 'name'] };
            }

            // 1. The programme's current reviewer steps down first (the one-active-reviewer index)
            const current = await activeReviewerOf(client, invite.programme_id, { lock: true });
            let replaced = null;
            if (current) {
                if (!invite.replace_reviewer) {
                    return { error: [409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a reviewer. Please ask the administrator.'] };
                }
                await client.query('UPDATE users SET reviewer_deactivated_at = now() WHERE id = $1', [current.id]);
                replaced = current.id;
            }

            // 2. The new reviewer: a new verified account, or the removed reviewer back again
            //    (same account and name, new password, possibly another programme)
            let reviewerId;
            if (account) {
                await client.query(
                    `UPDATE users SET password = $2, programme_id = $3, reviewer_deactivated_at = NULL, is_verified = true,
                        verification_token = NULL, reset_password_token = NULL, reset_password_expires = NULL
                     WHERE id = $1`,
                    [account.id, hashedPassword, invite.programme_id]
                );
                reviewerId = account.id;
            } else {
                const { rows } = await client.query(
                    `INSERT INTO users (name, email, password, role, is_verified, programme_id, preferred_language)
                     VALUES ($1, $2, $3, 'reviewer', true, $4, $5) RETURNING id`,
                    [cleanName, invite.email, hashedPassword, invite.programme_id, invite.language]
                );
                reviewerId = rows[0].id;
            }

            // 3. The programme's open applications move to the new reviewer. Only the assignment
            //    changes: reply deadlines and everything else about the student's reply stay as they are.
            const moved = await client.query(
                'UPDATE applications SET assigned_reviewer_id = $1 WHERE programme_id = $2 AND status = ANY($3)',
                [reviewerId, invite.programme_id, OPEN_STATUSES]
            );

            await client.query('UPDATE reviewer_invites SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [invite.id, reviewerId]);
            return { reactivated: !!account, replaced, moved: moved.rowCount };
        });
        if (result.error) {
            const [status, code, message, field] = result.error;
            return sendError(res, status, code, message, { field });
        }
        res.json({ success: true, reactivated: result.reactivated });
        console.log(`👤 Reviewer invite accepted: ${result.moved} open application(s) assigned${result.replaced ? `, reviewer #${result.replaced} deactivated` : ''}`);
    } catch (err) {
        // Two acceptances racing for one programme: the database keeps one active reviewer
        if (err.code === '23505' && err.constraint === 'users_one_active_reviewer_per_programme') {
            return sendError(res, 409, 'PROGRAMME_HAS_REVIEWER', 'This programme already has a reviewer. Please ask the administrator.');
        }
        if (err.code === '23505' && err.constraint === 'users_email_key') {
            return sendError(res, 409, 'EMAIL_TAKEN', 'This email already belongs to an account');
        }
        console.error('❌ Accept reviewer invite error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not accept the invitation');
    }
});

module.exports = router;
