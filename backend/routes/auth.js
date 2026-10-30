const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { signSessionToken } = require('../config/jwt');
const verifyToken = require('../middleware/verifyToken');
const pool = require('../db');
const crypto = require('crypto'); 
const sendEmail = require('../utils/sendEmail');
const { normalizeLanguage, buildAccountEmail } = require('../utils/emailTemplates');
const { checkEmailLink } = require('../utils/emailLink');
const sendError = require('../utils/sendError');
const { FRONTEND_URL } = require('../config/urls');
const { LIMITS, takeSlot, normalizeEmail, clientIp } = require('../utils/rateLimit');

// --- REGISTER ROUTE ---

// Neptun code: 6 letters or digits, stored in upper case (same rule as the database check)
const NEPTUN_PATTERN = /^[A-Z0-9]{6}$/;
const normalizeNeptun = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');

// The role comes from the university email domain
const roleForEmail = (lowerEmail) => {
    if (lowerEmail.endsWith('@tr.pte.hu')) return 'student';
    if (lowerEmail.endsWith('@mik.pte.hu')) return 'reviewer';
    if (lowerEmail.endsWith('@adminisztracio.pte.hu')) return 'superadmin';
    return null;
};

router.post('/register', async (req, res) => {
    const { name, email, password, language, neptun_code, programme_code } = req.body;

    // At most RATE_LIMIT_REGISTER_PER_IP attempts per hour from one IP (failed attempts count too).
    // A 429 is about the IP only, so it reveals nothing about any account.
    try {
        if (!(await takeSlot('register_ip', clientIp(req), LIMITS.registerPerIp))) {
            return sendError(res, 429, 'TOO_MANY_REQUESTS', 'Too many attempts, please try again later');
        }
    } catch (err) {
        console.error('Register rate limit error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Server error during registration');
    }
    
    if (![name, email, password].every((value) => typeof value === 'string' && value)) {
        return sendError(res, 400, 'MISSING_FIELDS', 'All fields required');
    }

    try {
        const lowerEmail = email.toLowerCase();
        const assignedRole = roleForEmail(lowerEmail);
        if (!assignedRole) return sendError(res, 400, 'INVALID_EMAIL_DOMAIN', 'Please use your university email address');

        // Students also give their Neptun code and study programme.
        // Reviewer and admin registration is unchanged: anything sent in these fields is ignored.
        let neptunCode = null;
        let programmeId = null;
        if (assignedRole === 'student') {
            neptunCode = normalizeNeptun(neptun_code);
            if (!NEPTUN_PATTERN.test(neptunCode)) {
                return sendError(res, 400, 'INVALID_NEPTUN', 'Neptun code must be 6 letters or digits');
            }
            const programme = typeof programme_code === 'string'
                ? await pool.query('SELECT id FROM programmes WHERE code = $1', [programme_code])
                : { rows: [] };
            if (programme.rows.length === 0) {
                return sendError(res, 400, 'INVALID_PROGRAMME', 'Unknown study programme');
            }
            programmeId = programme.rows[0].id;
        }

        const userExists = await pool.query('SELECT 1 FROM users WHERE email = $1', [lowerEmail]);
        if (userExists.rows.length > 0) return sendError(res, 400, 'EMAIL_TAKEN', 'Email already registered');

        if (neptunCode) {
            const neptunExists = await pool.query('SELECT 1 FROM users WHERE neptun_code = $1', [neptunCode]);
            if (neptunExists.rows.length > 0) return sendError(res, 400, 'NEPTUN_TAKEN', 'Neptun code already registered');
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const verificationToken = crypto.randomBytes(32).toString('hex');

        // is_verified starts as false (database default) until the email link is clicked
        try {
            await pool.query(
                `INSERT INTO users (name, email, password, role, verification_token, preferred_language, neptun_code, programme_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [name, lowerEmail, hashedPassword, assignedRole, verificationToken, normalizeLanguage(language), neptunCode, programmeId]
            );
        } catch (err) {
            // Two registrations at the same moment can both pass the checks above;
            // the database then refuses the second one (unique_violation)
            if (err.code === '23505' && err.constraint === 'users_neptun_code_key') {
                return sendError(res, 400, 'NEPTUN_TAKEN', 'Neptun code already registered');
            }
            if (err.code === '23505' && err.constraint === 'users_email_key') {
                return sendError(res, 400, 'EMAIL_TAKEN', 'Email already registered');
            }
            throw err;
        }

        // The verification link, in the language chosen on the registration form
        const verifyUrl = `${FRONTEND_URL}/verify/${verificationToken}`;
        const { subject, html } = buildAccountEmail('verifyAccount', language, { url: verifyUrl });
        await sendEmail({ email: lowerEmail, subject, html });

        res.json({ success: true, message: "Registration successful! Please check your email to verify your account." });

    } catch (err) {
        console.error(err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Server error during registration');
    }
});

// --- EMAIL LINK ROUTE ---
// Checks a link from a notification email. It never logs anyone in;
// it only says whether the link is still valid (10 minutes).
router.get('/email-link/:token', (req, res) => {
    const result = checkEmailLink(req.params.token);
    if (!result.valid) {
        return result.reason === 'expired'
            ? sendError(res, 410, 'LINK_EXPIRED', 'This link has expired')
            : sendError(res, 410, 'INVALID_LINK', 'This link is not valid');
    }
    res.json(result);
});

// --- VERIFY ROUTE ---
router.get('/verify/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const result = await pool.query(
            'UPDATE users SET is_verified = true, verification_token = NULL WHERE verification_token = $1 RETURNING *',
            [token]
        );

        if (result.rows.length === 0) {
            return sendError(res, 400, 'INVALID_VERIFY_LINK', 'Invalid or already used verification link');
        }

        res.json({ success: true, message: 'Email verified successfully! You may now close this tab and log in.' });
    } catch (err) {
        console.error(err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Verification failed');
    }
});

// --- LOGIN ROUTE ---
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    // 🆕 Quick validation for login
    if (!email || !password) {
        return sendError(res, 400, 'MISSING_FIELDS', 'All fields required');
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
        if (result.rows.length === 0) return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');

        const user = result.rows[0];
        
        // 🆕 YOUR ADDITION: Block unverified users right here!
        if (!user.is_verified) {
            return sendError(res, 403, 'EMAIL_NOT_VERIFIED', 'Please verify your email first. Check your inbox!');
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) return sendError(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');

        // 30-minute token, renewed by /refresh-token while the user is active
        const token = signSessionToken(user);
        
        res.json({ success: true, token, role: user.role });
    } catch (err) {
        console.error(err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Login failed');
    }
});

// --- REFRESH TOKEN ROUTE ---
// Called by the frontend while the user is active, to replace a token before it expires.
// verifyToken has already checked the token and re-read the user's current role.
// The original login time is kept, so a session still ends 8 hours after login.
router.post('/refresh-token', verifyToken, (req, res) => {
    const token = signSessionToken(req.user, req.sessionStart);
    res.json({ success: true, token, role: req.user.role });
});

// --- FORGOT PASSWORD ROUTE ---
const FORGOT_PASSWORD_MESSAGE = 'If that email exists, a reset link has been sent.';

// Creates a reset link (valid 1 hour), saves it and emails it. Runs AFTER the reply has been sent.
const sendResetLink = async (lowerEmail) => {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = Date.now() + 3600000; // 1 hour in milliseconds

    const updated = await pool.query(
        'UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE email = $3 RETURNING preferred_language',
        [resetToken, resetExpires, lowerEmail]
    );

    // In the account's saved language
    const resetUrl = `${FRONTEND_URL}/reset-password/${resetToken}`;
    const { subject, html } = buildAccountEmail('resetPassword', updated.rows[0]?.preferred_language, { url: resetUrl });
    await sendEmail({ email: lowerEmail, subject, html });
};

router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (typeof email !== 'string' || !email.trim()) return sendError(res, 400, 'MISSING_FIELDS', 'Email is required');
    const lowerEmail = normalizeEmail(email);

    try {
        // Rate limits, checked BEFORE looking the address up, so known and unknown addresses
        // go through exactly the same steps. Every request counts for its address whether or
        // not an account exists. Over a limit, the reply stays the same but no email is sent.
        const ipAllowed = await takeSlot('forgot_ip', clientIp(req), LIMITS.forgotPerIp);
        const emailAllowed = ipAllowed && await takeSlot('forgot_email', lowerEmail, LIMITS.forgotPerEmail);

        const result = await pool.query('SELECT id FROM users WHERE email = $1', [lowerEmail]);

        // Don't reveal whether the email exists: the same answer, sent at the same moment
        // (right after the lookup) in both cases. The slow part, saving the link and
        // talking to the mail server, happens after the reply.
        res.json({ success: true, message: FORGOT_PASSWORD_MESSAGE });

        if (emailAllowed && result.rows.length > 0) {
            // The reply is already sent, so a failure here can only be logged.
            // The .catch() also covers any error thrown inside sendResetLink.
            sendResetLink(lowerEmail).catch((err) => console.error('Forgot password (after reply) error:', err.message));
        }
    } catch (err) {
        console.error("Forgot password error:", err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Server error');
    }
});

// --- RESET PASSWORD ROUTE ---
router.post('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) return sendError(res, 400, 'MISSING_FIELDS', 'New password is required');

    try {
        // 1. Find user by token AND ensure the token hasn't expired
        const result = await pool.query(
            'SELECT * FROM users WHERE reset_password_token = $1 AND reset_password_expires > $2',
            [token, Date.now()]
        );

        if (result.rows.length === 0) {
            return sendError(res, 400, 'INVALID_RESET_LINK', 'Password reset link is invalid or has expired');
        }

        const user = result.rows[0];

        // 2. Hash the new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // 3. Update password and clear the reset tokens
        await pool.query(
            'UPDATE users SET password = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2',
            [hashedPassword, user.id]
        );

        res.json({ success: true, message: "Password has been successfully reset! You may now log in." });

    } catch (err) {
        console.error("Reset password error:", err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Server error');
    }
});
module.exports = router;