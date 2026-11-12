const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireCommittee = require('../middleware/requireCommittee');
const sendError = require('../utils/sendError');
const { committeeProgrammes, reviewerProgrammes } = require('../utils/reviewers');

// The committee (round 2 Group 2). After a reviewer (or an admin) decides, the programme's committee
// confirms it: keep or change. Access always comes from the person's CURRENT committee links, read
// from the database on every request (middleware/requireCommittee.js). Part A: who the member is.

// GET /api/committee/me: the member's committee programmes, and whether they are also a reviewer
// (then the dashboard offers a Reviewer / Committee switch). No current programme: an empty list.
router.get('/committee/me', verifyToken, requireCommittee, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const me = (await pool.query('SELECT id, name FROM users WHERE id = $1', [req.user.id])).rows[0];
        const programmes = await committeeProgrammes(pool, req.user.id);
        const reviewerLinks = req.user.role === 'reviewer' ? await reviewerProgrammes(pool, req.user.id) : [];
        res.json({
            success: true,
            member: { id: me.id, name: me.name },
            programmes: programmes.map(({ code, name_en, name_hu, name_de }) => ({ code, name_en, name_hu, name_de })),
            alsoReviewer: req.user.role === 'reviewer',
            reviewerProgrammes: reviewerLinks.length,
        });
    } catch (err) {
        console.error('❌ Committee me error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

module.exports = router;
