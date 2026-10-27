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
        const userResult = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) {
            return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');
        }
        const targetUser = userResult.rows[0];

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

// Course catalogue for the application form: any logged-in user
router.get('/pte-courses', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM courses');
        res.json({ success: true, courses: result.rows });
    } catch {
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

module.exports = router;
