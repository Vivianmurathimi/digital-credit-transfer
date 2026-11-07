const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');

// The superadmin's overview of the reviewer side (reviewer Group 7), shown as a banner on the admin
// dashboard: per programme its active reviewer (name only), how many applications wait for a
// decision (pending) and how many wait for the student's reply (needs_info), and the running
// semester's last day (after it, undecided applications are rejected automatically).
// Counts are all open applications of the programme, like the reviewer's own list.
// Kept minimal: the admin round redesigns the dashboard.

router.get('/admin/reviewer-overview', verifyToken, requireRole('superadmin'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const semester = (await pool.query(
            `SELECT name, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
             FROM semester_bounds WHERE opens_at <= now() AND ends_at > now() LIMIT 1`
        )).rows[0] || null;
        const { rows } = await pool.query(
            `SELECT p.code, p.name_en, p.name_hu, p.name_de, r.name AS reviewer_name,
                    count(a.id) FILTER (WHERE a.status = 'pending')::int AS pending,
                    count(a.id) FILTER (WHERE a.status = 'needs_info')::int AS needs_info
             FROM programmes p
             LEFT JOIN users r ON r.role = 'reviewer' AND r.reviewer_deactivated_at IS NULL AND r.programme_id = p.id
             LEFT JOIN applications a ON a.programme_id = p.id AND a.status IN ('pending', 'needs_info')
             GROUP BY p.id, r.name
             ORDER BY p.code`
        );
        res.json({
            success: true,
            semester: semester && { name: semester.name, endsOn: semester.ends_on },
            programmes: rows.map((row) => ({
                code: row.code,
                name_en: row.name_en,
                name_hu: row.name_hu,
                name_de: row.name_de,
                reviewer: row.reviewer_name ? { name: row.reviewer_name } : null,
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
