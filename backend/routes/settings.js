const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET: Check if submissions are open
router.get('/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT is_submissions_open FROM system_settings LIMIT 1');
        res.json({ success: true, isOpen: result.rows[0].is_submissions_open });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch system status" });
    }
});

// PUT: Super Admin toggles the switch
router.put('/toggle', async (req, res) => {
    try {
        const { isOpen } = req.body;
        await pool.query('UPDATE system_settings SET is_submissions_open = $1', [isOpen]);
        res.json({ success: true, isOpen });
    } catch (err) {
        res.status(500).json({ error: "Failed to toggle system status" });
    }
});

module.exports = router;