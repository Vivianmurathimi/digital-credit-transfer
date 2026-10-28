const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');

// GET: Check if submissions are open (any logged-in user can check)
router.get('/status', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT is_submissions_open FROM system_settings LIMIT 1');
        res.json({ success: true, isOpen: result.rows[0].is_submissions_open });
    } catch (err) {
        sendError(res, 500, 'SERVER_ERROR', 'Failed to fetch system status');
    }
});

// PUT: Super Admin toggles the switch (superadmin only)
router.put('/toggle', verifyToken, requireRole('superadmin'), async (req, res) => {
    try {
        const { isOpen } = req.body;
        await pool.query('UPDATE system_settings SET is_submissions_open = $1', [isOpen]);
        res.json({ success: true, isOpen });
    } catch (err) {
        sendError(res, 500, 'SERVER_ERROR', 'Failed to toggle system status');
    }
});

module.exports = router;