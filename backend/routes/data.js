const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');
const { COUNTRY_CODES } = require('../utils/countries');
const { periodFor } = require('../utils/applicationPeriod');

// Used for the superadmin's "act as" lists (admin round Group 1) — superadmins intentionally excluded.
// Deactivated reviewers are marked, because nobody can act as them.
// Superadmin only: it lists every student's and reviewer's name and email.
router.get('/users', verifyToken, requireRole('superadmin'), async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, email, role, (deactivated_at IS NOT NULL) AS deactivated FROM users WHERE role != 'superadmin' ORDER BY name");
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

// No role-change route (admin round Group 2): roles come only from invites, so the
// one-reviewer-per-programme and last-admin rules can't be got around.

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
        // Only active programmes are offered (admin round Group 4: hidden ones are not)
        const result = await pool.query("SELECT code, name_en, name_hu, name_de FROM programmes WHERE status = 'active' ORDER BY code");
        res.json({ success: true, programmes: result.rows });
    } catch (err) {
        console.error('Fetch programmes error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// Country codes for the application form's institution dropdown: public, codes only
// (the browser shows the names in the user's language). The same list the server checks against.
router.get('/countries', (req, res) => {
    res.json({ success: true, countries: COUNTRY_CODES });
});

// PTE target courses for the application form.
// Students get only their own programme's courses: the programme is read from the database
// for the id in the checked token, never from the request (any query is ignored).
// And only the current semester's (or, before it starts, the coming one's); between semesters
// none (Group 3). Courses from before semesters (no semester) are never offered.
// Reviewers and the superadmin still get every course for now (while the superadmin acts as a
// student, the student's rule applies); the admin round can narrow this.
router.get('/pte-courses', verifyToken, async (req, res) => {
    try {
        // The catalogue of the semester a new application would go to (the late access's own semester,
        // or the open period's), otherwise the semester the period rule talks about
        const period = req.user.role === 'student' ? await periodFor(pool, { userId: req.user.id }) : null;
        const semester = period ? period.submitSemester || period.semester : null;
        const result = req.user.role === 'student'
            ? await pool.query(
                `SELECT c.id, c.course_code, c.course_name, c.credits
                 FROM courses c
                 JOIN users u ON u.programme_id = c.programme_id
                 JOIN programmes p ON p.id = u.programme_id AND p.status = 'active'
                 WHERE u.id = $1 AND c.semester_id = $2 AND c.status = 'active'
                 ORDER BY c.course_code`,
                [req.user.id, semester ? semester.id : null]
            )
            : await pool.query('SELECT id, course_code, course_name, credits FROM courses ORDER BY course_code');
        res.json({ success: true, courses: result.rows });
    } catch (err) {
        console.error('Fetch courses error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

module.exports = router;
