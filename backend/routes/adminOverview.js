const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');

// The superadmin's overview of the reviewer side (reviewer Group 7), shown as a banner on the admin
// dashboard: per programme its main reviewer and extra reviewers (names only), how many applications wait for a
// decision (pending) and how many wait for the student's reply (needs_info), and the running
// semester's last day (after it, undecided applications are rejected automatically).
// Counts are all open applications of the programme, like the reviewer's own list.
// Kept minimal: the admin round redesigns the dashboard.

router.get('/admin/reviewer-overview', verifyToken, requireRole('superadmin'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        // The semester in progress whose review deadline comes first (several can be in progress,
        // round 2 Group 1); its review deadline is the date the banner names
        const semester = (await pool.query(
            `SELECT name, review_ends_at FROM semester_bounds WHERE status = 'active'
             ORDER BY (review_ends_at <= now()), review_ends_at LIMIT 1`
        )).rows[0] || null;
        const { rows } = await pool.query(
            `SELECT p.code, p.name_en, p.name_hu, p.name_de,
                    (SELECT u.name FROM staff_programmes sp JOIN users u ON u.id = sp.user_id AND u.deactivated_at IS NULL
                     WHERE sp.programme_id = p.id AND sp.role = 'main' AND sp.ended_at IS NULL) AS reviewer_name,
                    COALESCE((SELECT json_agg(json_build_object('name', u.name, 'can_assist', sp.can_assist) ORDER BY u.name)
                              FROM staff_programmes sp JOIN users u ON u.id = sp.user_id AND u.deactivated_at IS NULL
                              WHERE sp.programme_id = p.id AND sp.role = 'extra' AND sp.ended_at IS NULL), '[]') AS extras,
                    count(a.id) FILTER (WHERE a.status = 'pending')::int AS pending,
                    count(a.id) FILTER (WHERE a.status = 'needs_info')::int AS needs_info
             FROM programmes p
             LEFT JOIN applications a ON a.programme_id = p.id AND a.status IN ('pending', 'needs_info')
             GROUP BY p.id
             ORDER BY p.code`
        );
        res.json({
            success: true,
            semester: semester && { name: semester.name, reviewEndsAt: semester.review_ends_at },
            programmes: rows.map((row) => ({
                code: row.code,
                name_en: row.name_en,
                name_hu: row.name_hu,
                name_de: row.name_de,
                reviewer: row.reviewer_name ? { name: row.reviewer_name } : null, // the main reviewer
                extras: row.extras, // extra reviewers: [{ name, can_assist }]
                pending: row.pending,
                needs_info: row.needs_info,
            })),
        });
    } catch (err) {
        console.error('❌ Reviewer overview error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

module.exports = router;
