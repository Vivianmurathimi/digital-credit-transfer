const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');

// Used for the superadmin's impersonation dropdowns — superadmins intentionally excluded.
// Superadmin only: it lists every student's and reviewer's name and email.
router.get('/users', verifyToken, requireRole('superadmin'), async (req, res) => {
    try {
        const result = await pool.query("SELECT id,name,email,role FROM users WHERE role!='superadmin'");
        res.json({ success: true, users: result.rows });
    } catch (err) {
        sendError(res, 500, 'SERVER_ERROR', 'Fetch users failed');
    }
});

// NEW: full user list including superadmins — for role management only
router.get('/users/all', verifyToken, requireRole('superadmin'), async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, email, role FROM users ORDER BY role, name");
        res.json({ success: true, users: result.rows });
    } catch (err) {
        sendError(res, 500, 'SERVER_ERROR', 'Fetch users failed');
    }
});

// Save a user's language choice (used for their notification emails).
// Users can only change their own language.
router.put('/users/:id/language', verifyToken, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const language = String(req.body.language || '').slice(0, 2).toLowerCase();

    if (req.user.id !== id) {
        return sendError(res, 403, 'NOT_OWNER', 'You can only change your own language');
    }
    if (!['hu', 'en', 'de'].includes(language)) {
        return sendError(res, 400, 'UNSUPPORTED_LANGUAGE', 'Unsupported language');
    }

    try {
        await pool.query('UPDATE users SET preferred_language = $1 WHERE id = $2', [language, id]);
        res.json({ success: true, language });
    } catch (err) {
        console.error('❌ Language update error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Language update failed');
    }
});

// NEW: change a user's role — superadmin only
router.put('/users/:id/role', verifyToken, requireRole('superadmin'), async (req, res) => {
    const { id } = req.params;
    const { newRole } = req.body;
    const validRoles = ['student', 'reviewer', 'superadmin'];

    if (!validRoles.includes(newRole)) {
        return sendError(res, 400, 'INVALID_ROLE', 'Invalid role specified');
    }

    try {
        const userResult = await pool.query('SELECT id, role, neptun_code, programme_id FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) {
            return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');
        }
        const targetUser = userResult.rows[0];

        // Students must have a Neptun code and a programme (database rule). Until the admin
        // round adds a programme picker here, an account without them can't become a student.
        if (newRole === 'student' && targetUser.role !== 'student' && (!targetUser.neptun_code || !targetUser.programme_id)) {
            return sendError(res, 400, 'STUDENT_PROFILE_REQUIRED', 'This account has no Neptun code or programme, so it cannot be made a student yet');
        }

        if (targetUser.role === 'superadmin' && newRole !== 'superadmin') {
            const countResult = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'superadmin'");
            const superadminCount = parseInt(countResult.rows[0].count, 10);

            if (superadminCount <= 1) {
                return sendError(res, 400, 'LAST_SUPERADMIN', 'Cannot remove the last remaining superadmin');
            }
        }

        const updateResult = await pool.query(
            'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role',
            [newRole, id]
        );

        res.json({ success: true, user: updateResult.rows[0] });

    } catch (err) {
        console.error('Role update error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Failed to update role');
    }
});

// The logged-in user's own profile. Takes NO id from the request (no :id, query or body):
// only the id from the checked token, so it can never return another user.
// Explicit columns only: never the password or any token.
router.get('/me', verifyToken, async (req, res) => {
    // Shared lab computers: the browser must not keep a copy of these details
    res.set('Cache-Control', 'no-store');
    try {
        const result = await pool.query(
            `SELECT u.name, u.email, u.role, u.neptun_code,
                    p.code AS programme_code, p.name_en, p.name_hu, p.name_de
             FROM users u
             LEFT JOIN programmes p ON p.id = u.programme_id
             WHERE u.id = $1`,
            [req.user.id]
        );
        // verifyToken has just found this user, so a missing row means it was deleted in between
        if (result.rows.length === 0) return sendError(res, 401, 'ACCOUNT_GONE', 'Account no longer exists');

        const { programme_code: code, name_en, name_hu, name_de, ...user } = result.rows[0];
        res.json({ success: true, user: { ...user, programme: code ? { code, name_en, name_hu, name_de } : null } });
    } catch (err) {
        console.error('Fetch own profile error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// Study programmes for the registration form: public (no login), names in EN/HU/DE
router.get('/programmes', async (req, res) => {
    try {
        const result = await pool.query('SELECT code, name_en, name_hu, name_de FROM programmes ORDER BY code');
        res.json({ success: true, programmes: result.rows });
    } catch (err) {
        console.error('Fetch programmes error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// PTE target courses for the application form.
// Students get only their own programme's courses: the programme is read from the database
// for the id in the checked token, never from the request (any query is ignored).
// Reviewers and the superadmin still get every course for now (also used while the superadmin
// impersonates a student); the reviewer and admin rounds can narrow this.
router.get('/pte-courses', verifyToken, async (req, res) => {
    try {
        const result = req.user.role === 'student'
            ? await pool.query(
                `SELECT c.id, c.course_code, c.course_name, c.credits
                 FROM courses c
                 JOIN users u ON u.programme_id = c.programme_id
                 WHERE u.id = $1
                 ORDER BY c.course_code`,
                [req.user.id]
            )
            : await pool.query('SELECT id, course_code, course_name, credits FROM courses ORDER BY course_code');
        res.json({ success: true, courses: result.rows });
    } catch (err) {
        console.error('Fetch courses error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

module.exports = router;
