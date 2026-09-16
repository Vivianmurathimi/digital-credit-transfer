const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');

// Existing: used for impersonation dropdowns — superadmins intentionally excluded
router.get('/users', verifyToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT id,name,email,role FROM users WHERE role!='superadmin'");
        res.json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch users failed" });
    }
});

// NEW: full user list including superadmins — for role management only
router.get('/users/all', verifyToken, requireRole('superadmin'), async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, email, role FROM users ORDER BY role, name");
        res.json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch users failed" });
    }
});

// NEW: change a user's role — superadmin only
router.put('/users/:id/role', verifyToken, requireRole('superadmin'), async (req, res) => {
    const { id } = req.params;
    const { newRole } = req.body;
    const validRoles = ['student', 'reviewer', 'superadmin'];

    if (!validRoles.includes(newRole)) {
        return res.status(400).json({ error: "Invalid role specified" });
    }

    try {
        const userResult = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        const targetUser = userResult.rows[0];

        if (targetUser.role === 'superadmin' && newRole !== 'superadmin') {
            const countResult = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'superadmin'");
            const superadminCount = parseInt(countResult.rows[0].count, 10);

            if (superadminCount <= 1) {
                return res.status(400).json({ error: "Cannot remove the last remaining superadmin" });
            }
        }

        const updateResult = await pool.query(
            'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, name, email, role',
            [newRole, id]
        );

        res.json({ success: true, user: updateResult.rows[0] });

    } catch (err) {
        console.error('Role update error:', err.message);
        res.status(500).json({ error: "Failed to update role" });
    }
});

router.get('/pte-courses', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM courses');
        res.json({ success: true, courses: result.rows });
    } catch {
        res.status(500).json({ error: "Fetch failed" });
    }
});

module.exports = router;
