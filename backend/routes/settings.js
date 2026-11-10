const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const sendError = require('../utils/sendError');
const { periodFor, publicPeriod } = require('../utils/applicationPeriod');

// The application period as the caller sees it (admin round Group 5). The old admin toggle
// (PUT /toggle, system_settings) is gone: the active semester's dates, Close now, Reopen until
// and late access decide, all in utils/applicationPeriod.js.

// GET /api/settings/status: what the logged-in person can do right now (their late access counts).
// A student of a hidden programme can't start new applications (admin round Group 4).
router.get('/status', verifyToken, async (req, res) => {
    try {
        const submission = publicPeriod(await periodFor(pool, { userId: req.user.role === 'student' ? req.user.id : null }));
        if (req.user.role === 'student') {
            const programme = (await pool.query('SELECT p.status FROM users u JOIN programmes p ON p.id = u.programme_id WHERE u.id = $1', [req.user.id])).rows[0];
            if (programme?.status === 'hidden') Object.assign(submission, { state: 'programme_hidden', canSubmit: false });
        }
        res.json({ success: true, submission });
    } catch (err) {
        console.error('❌ Period status error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Failed to fetch the application period');
    }
});

// GET /api/settings/period: public (the registration page, before anyone logs in). The period
// only; late access is checked by the server when someone actually registers.
router.get('/period', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { lateAccess, ...period } = publicPeriod(await periodFor(pool));
        res.json({ success: true, period });
    } catch (err) {
        console.error('❌ Public period error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Failed to fetch the application period');
    }
});

module.exports = router;
