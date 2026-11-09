const crypto = require('crypto');
const sendEmail = require('./sendEmail');
const { buildAccountEmail, normalizeLanguage } = require('./emailTemplates');
const { FRONTEND_URL } = require('../config/urls');

// Invites for reviewers and admins (reviewer Group 2, admin round Group 2), shared by the invite
// routes (routes/staffInvites.js) and the first-admin script (admin.js).
// The link is valid for 7 days and works once. Only a SHA-256 hash of its token is stored, so the
// database never holds a working link.

const INVITE_DAYS = 7;
const INVITE_ROLES = ['reviewer', 'superadmin'];
const MAX_EMAIL_LENGTH = 100; // users.email
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const newToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const inviteLink = (token) => `${FRONTEND_URL}/invite/${token}`;

// The status is never stored: worked out from the timestamps when read (no job needed for "expired")
const INVITE_STATUSES = ['sent', 'accepted', 'expired', 'cancelled'];
const INVITE_STATUS_SQL = `CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted'
                                WHEN i.cancelled_at IS NOT NULL THEN 'cancelled'
                                WHEN i.expires_at <= now() THEN 'expired'
                                ELSE 'sent' END`;
// Still usable or resendable: not accepted and not cancelled (expired ones can be resent)
const OPEN_INVITE = 'i.accepted_at IS NULL AND i.cancelled_at IS NULL';

const isValidInviteEmail = (email) => !!email && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);

const programmeNameIn = (programme, language) => (programme ? programme[`name_${language}`] || programme.name_en : '');

/**
 * Sends the invite email in the invite's language. Never throws: call it without await, after the reply.
 * @param {{ email: string, language: string, role: 'reviewer'|'superadmin', programme?: object|null, token: string }} invite
 */
const sendInviteEmail = async ({ email, language, role, programme = null, token }) => {
    try {
        const lang = normalizeLanguage(language);
        const type = role === 'superadmin' ? 'adminInvite' : 'reviewerInvite';
        const { subject, html } = buildAccountEmail(type, lang, { url: inviteLink(token), programme: programmeNameIn(programme, lang) });
        await sendEmail({ email, subject, html });
    } catch (err) {
        console.error(`❌ Invite email to ${email} failed:`, err.message);
    }
};

/**
 * Whether this address may be invited for this role. A new address may; so may a DEACTIVATED
 * account of the same role (accepting reactivates it: same id, so its past decisions stay linked).
 * An address with an active account (student, reviewer or admin) is refused.
 * @returns {Promise<{ error?: [number, string, string] }>}
 */
const checkInviteAddress = async (db, email, role) => {
    const account = (await db.query('SELECT role, deactivated_at FROM users WHERE email = $1', [email])).rows[0];
    if (!account) return {};
    if (!account.deactivated_at) {
        return { error: [409, 'EMAIL_TAKEN', 'This email already belongs to an active account'] };
    }
    if (account.role !== role) {
        return { error: [409, 'EMAIL_TAKEN_OTHER_ROLE', 'This email belongs to a deactivated account with another role'] };
    }
    return {};
};

/**
 * Saves a new invite (inside the caller's transaction). An open invite for the same address is
 * cancelled first: its link stops working.
 * @returns {Promise<{ id: number, token: string }>}
 */
const createInvite = async (client, { email, role, programmeId = null, replace = false, language, invitedBy = null }) => {
    const token = newToken();
    await client.query(
        'UPDATE staff_invites SET cancelled_at = now() WHERE email = $1 AND accepted_at IS NULL AND cancelled_at IS NULL',
        [email]
    );
    const { rows } = await client.query(
        `INSERT INTO staff_invites (email, role, programme_id, replace_reviewer, language, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8)) RETURNING id`,
        [email, role, programmeId, replace === true, normalizeLanguage(language), hashToken(token), invitedBy, INVITE_DAYS]
    );
    return { id: rows[0].id, token };
};

module.exports = {
    INVITE_DAYS, INVITE_ROLES, INVITE_STATUSES, INVITE_STATUS_SQL, OPEN_INVITE,
    newToken, hashToken, inviteLink, isValidInviteEmail, sendInviteEmail, checkInviteAddress, createInvite,
};
