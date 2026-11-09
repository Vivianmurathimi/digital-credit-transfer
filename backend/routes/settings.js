const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');
const { getSubmissionState, publicSubmissionState } = require('../utils/semesters');

// GET: whether submissions are open (any logged-in user can check).
// isOpen is the admin's toggle (the admin screen shows it); submission is what students can do
// right now, from the semester's application period and the toggle together (Group 3).
router.get('/status', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT is_submissions_open FROM system_settings LIMIT 1');
        const submission = publicSubmissionState(await getSubmissionState());
        res.json({ success: true, isOpen: result.rows[0].is_submissions_open, submission });
    } catch (err) {
        sendError(res, 500, 'SERVER_ERROR', 'Failed to fetch system status');
    }
});

// PUT: Super Admin toggles the switch (superadmin only)
router.put('/toggle', verifyToken, requireRole('superadmin'), async (req, res) => {
    // Only a real true/false: anything else ("yes", 1, missing) would be saved as something unintended
    const isOpen = req.body?.isOpen;
    if (typeof isOpen !== 'boolean') return sendError(res, 400, 'INVALID_IS_OPEN', 'isOpen must be true or false', { field: 'isOpen' });
    try {
        await pool.query('UPDATE system_settings SET is_submissions_open = $1', [isOpen]);
        res.json({ success: true, isOpen });
    } catch (err) {
        sendError(res, 500, 'SERVER_ERROR', 'Failed to toggle system status');
    }
});

module.exports = router;