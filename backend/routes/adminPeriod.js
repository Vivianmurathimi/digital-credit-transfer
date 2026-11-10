const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { requireIdParam } = require('../utils/validate');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const sendEmail = require('../utils/sendEmail');
const { buildAccountEmail, normalizeLanguage } = require('../utils/emailTemplates');
const { FRONTEND_URL } = require('../config/urls');
const { normalizeEmail } = require('../utils/rateLimit');
const { isAllowedStudentEmail } = require('../utils/domains');
const { isValidInviteEmail } = require('../utils/staffInvites');

// The application period's controls (admin round Group 5), superadmin only:
//   Close now / Reopen until on the active semester (they change its closing time; the period
//   rule in utils/applicationPeriod.js does the rest), late access, and the admin menu's summary.
// Times from the screen are Budapest wall-clock times ("2026-12-01T23:59").

const adminOnly = [verifyToken, requireRole('superadmin')];
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_REASON = 300;
const MAX_EMAILS = 100;

const isLocalTime = (value) => {
    if (typeof value !== 'string' || !LOCAL_TIME.test(value)) return false;
    const date = new Date(`${value}:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 16) === value;
};

// The active semester (locked inside a transaction), with what the controls need to know
const activeSemester = (db, id, { lock = false } = {}) => db.query(
    `SELECT s.id, s.name, s.status, s.applications_open_at <= now() AS started, s.applications_close_at <= now() AS period_over,
            (s.end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' <= now() AS ended, to_char(s.end_date, 'YYYY-MM-DD') AS end_date
     FROM semesters s WHERE s.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id]
).then((r) => r.rows[0]);

// ---------------------------------------------------------------------------------------------
// Close now and Reopen until
// ---------------------------------------------------------------------------------------------

// POST /api/admin/semesters/:id/close-now { reason? }: ends the period at once (the active
// semester, while its period runs). The reason is shown to students.
router.post('/admin/semesters/:id/close-now', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (req.body?.reason !== undefined && typeof req.body.reason !== 'string') return sendError(res, 400, 'INVALID_REASON', 'reason must be text', { field: 'reason' });
    if (reason.length > MAX_REASON) return sendError(res, 400, 'REASON_TOO_LONG', `At most ${MAX_REASON} characters`, { field: 'reason' });
    try {
        const result = await inTransaction(async (client) => {
            const s = await activeSemester(client, req.ids.id, { lock: true });
            if (!s) return { error: [404, 'SEMESTER_NOT_FOUND', 'Semester not found'] };
            if (s.status !== 'active') return { error: [409, 'SEMESTER_NOT_ACTIVE', 'Only the active semester has an application period to close'] };
            if (!s.started || s.period_over || s.ended) return { error: [409, 'PERIOD_NOT_OPEN', 'The application period is not open right now'] };
            // close_reason: '' = closed by the admin without a reason (NULL = closed by its dates)
            await client.query('UPDATE semesters SET applications_close_at = now(), close_reason = $2 WHERE id = $1', [s.id, reason]);
            return {};
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2]);
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Close now error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not close the application period');
    }
});

// POST /api/admin/semesters/:id/reopen { until }: open again for everyone until a new closing
// time in the future (on or before the semester's last day). The Close now reason is cleared.
router.post('/admin/semesters/:id/reopen', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const until = req.body?.until;
    if (!isLocalTime(until)) return sendError(res, 400, 'INVALID_TIME', 'until must be a date and time', { field: 'until' });
    try {
        const result = await inTransaction(async (client) => {
            const s = await activeSemester(client, req.ids.id, { lock: true });
            if (!s) return { error: [404, 'SEMESTER_NOT_FOUND', 'Semester not found'] };
            if (s.status !== 'active') return { error: [409, 'SEMESTER_NOT_ACTIVE', 'Only the active semester can be reopened'] };
            if (!s.started) return { error: [409, 'PERIOD_NOT_STARTED', 'The period has not started yet: change its dates instead'] };
            if (s.ended) return { error: [409, 'SEMESTER_CLOSED', 'The semester has ended'] };
            const check = (await client.query(
                "SELECT ($1::timestamp AT TIME ZONE 'Europe/Budapest') > now() AS future, $1::date <= $2::date AS in_semester",
                [until, s.end_date]
            )).rows[0];
            if (!check.future) return { error: [400, 'TIME_NOT_IN_FUTURE', 'The new closing time must be in the future', 'until'] };
            if (!check.in_semester) return { error: [400, 'END_BEFORE_CLOSE', 'The semester ends before that', 'until'] };
            await client.query(
                "UPDATE semesters SET applications_close_at = $2::timestamp AT TIME ZONE 'Europe/Budapest', close_reason = NULL WHERE id = $1",
                [s.id, until]
            );
            return {};
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2], { field: result.error[3] });
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Reopen error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not reopen the application period');
    }
});

// ---------------------------------------------------------------------------------------------
// Late access
// ---------------------------------------------------------------------------------------------

const LATE_COLUMNS = `
    l.id, l.email, l.deadline, l.created_at, l.revoked_at, g.name AS granted_by_name, r.name AS revoked_by_name,
    CASE WHEN l.revoked_at IS NOT NULL THEN 'revoked' WHEN l.deadline <= now() THEN 'expired' ELSE 'active' END AS status,
    EXISTS (SELECT 1 FROM users u WHERE u.email = l.email) AS registered`;

const currentSemesterId = async (db) => (await db.query("SELECT id FROM semesters WHERE status = 'active'")).rows[0]?.id ?? null;

// GET /api/admin/late-access: the active semester's late access, newest first
router.get('/admin/late-access', ...adminOnly, async (req, res) => {
    try {
        const semesterId = await currentSemesterId(pool);
        if (!semesterId) return res.json({ success: true, semester: null, grants: [] });
        const semester = (await pool.query('SELECT id, name FROM semesters WHERE id = $1', [semesterId])).rows[0];
        const { rows } = await pool.query(
            `SELECT ${LATE_COLUMNS} FROM late_access l LEFT JOIN users g ON g.id = l.granted_by LEFT JOIN users r ON r.id = l.revoked_by
             WHERE l.semester_id = $1 ORDER BY l.created_at DESC, l.id DESC`,
            [semesterId]
        );
        res.json({ success: true, semester, grants: rows });
    } catch (err) {
        console.error('❌ Late access list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list late access');
    }
});

// Sends the late access email: registered students in their language with the login link, others
// in the admin's chosen language with the registration link. Never throws.
const sendLateAccessEmail = async ({ email, deadline, language, registered }) => {
    try {
        const url = `${FRONTEND_URL}/${registered ? 'login' : 'register'}`;
        const { subject, html } = buildAccountEmail('lateAccess', language, { url, deadline });
        await sendEmail({ email, subject, html });
    } catch (err) {
        console.error(`❌ Late access email to ${email} failed:`, err.message);
    }
};

// POST /api/admin/late-access { emails: "a@x, b@y" | [..], deadline, language? }
// For the active semester. Each address is checked on its own; a bad one doesn't stop the others.
// Granting again to the same address replaces its earlier grant.
router.post('/admin/late-access', ...adminOnly, async (req, res) => {
    const { emails, deadline, language } = req.body || {};
    const list = (Array.isArray(emails) ? emails : String(emails ?? '').split(/[\s,;]+/))
        .map((e) => (typeof e === 'string' ? normalizeEmail(e) : '')).filter(Boolean);
    const unique = [...new Set(list)];
    if (unique.length === 0) return sendError(res, 400, 'NO_EMAILS', 'Enter at least one email address', { field: 'emails' });
    if (unique.length > MAX_EMAILS) return sendError(res, 400, 'TOO_MANY_EMAILS', `At most ${MAX_EMAILS} addresses at once`, { field: 'emails' });
    if (!isLocalTime(deadline)) return sendError(res, 400, 'INVALID_TIME', 'deadline must be a date and time', { field: 'deadline' });
    if (language !== undefined && !['hu', 'en', 'de'].includes(language)) return sendError(res, 400, 'UNSUPPORTED_LANGUAGE', 'Unsupported language', { field: 'language' });

    try {
        const outcome = await inTransaction(async (client) => {
            const semesterId = await currentSemesterId(client);
            if (!semesterId) return { error: [409, 'NO_ACTIVE_SEMESTER', 'There is no active semester'] };
            const s = await activeSemester(client, semesterId, { lock: true });
            const check = (await client.query(
                "SELECT ($1::timestamp AT TIME ZONE 'Europe/Budapest') AS at, ($1::timestamp AT TIME ZONE 'Europe/Budapest') > now() AS future, $1::date <= $2::date AS in_semester",
                [deadline, s.end_date]
            )).rows[0];
            if (!check.future) return { error: [400, 'TIME_NOT_IN_FUTURE', 'The deadline must be in the future', 'deadline'] };
            if (!check.in_semester) return { error: [400, 'END_BEFORE_CLOSE', 'The semester ends before that deadline', 'deadline'] };

            const results = [];
            const toEmail = [];
            for (const email of unique) {
                if (!isValidInviteEmail(email)) { results.push({ email, ok: false, code: 'INVALID_EMAIL' }); continue; }
                // Staff accounts never get late access (they don't apply)
                const account = (await client.query('SELECT role, preferred_language FROM users WHERE email = $1', [email])).rows[0];
                if (account && account.role !== 'student') { results.push({ email, ok: false, code: 'NOT_A_STUDENT_EMAIL' }); continue; }
                // The domain must still be on the allowed list
                if (!(await isAllowedStudentEmail(client, email))) { results.push({ email, ok: false, code: 'EMAIL_DOMAIN_NOT_ALLOWED' }); continue; }
                await client.query(
                    'UPDATE late_access SET revoked_at = now(), revoked_by = $3 WHERE semester_id = $1 AND email = $2 AND revoked_at IS NULL',
                    [semesterId, email, req.actor.id]
                );
                await client.query(
                    'INSERT INTO late_access (email, semester_id, deadline, granted_by) VALUES ($1, $2, $3, $4)',
                    [email, semesterId, check.at, req.actor.id]
                );
                results.push({ email, ok: true, registered: !!account });
                toEmail.push({ email, deadline: check.at, registered: !!account, language: account ? account.preferred_language : normalizeLanguage(language) });
            }
            return { results, toEmail };
        });
        if (outcome.error) return sendError(res, outcome.error[0], outcome.error[1], outcome.error[2], { field: outcome.error[3] });
        res.status(201).json({ success: true, results: outcome.results });
        for (const item of outcome.toEmail) sendLateAccessEmail(item);
        return undefined;
    } catch (err) {
        console.error('❌ Grant late access error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not grant late access');
    }
});

// DELETE /api/admin/late-access/:id: revokes at once (the next request already counts it)
router.delete('/admin/late-access/:id', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT revoked_at FROM late_access WHERE id = $1', [req.ids.id]);
        if (rows.length === 0) return sendError(res, 404, 'LATE_ACCESS_NOT_FOUND', 'Late access not found');
        if (rows[0].revoked_at) return res.json({ success: true, alreadyRevoked: true });
        await pool.query('UPDATE late_access SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL', [req.ids.id, req.actor.id]);
        return res.json({ success: true, alreadyRevoked: false });
    } catch (err) {
        console.error('❌ Revoke late access error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not revoke late access');
    }
});

// ---------------------------------------------------------------------------------------------
// The admin menu's summary (badges and the Overview): read-only counts
// ---------------------------------------------------------------------------------------------

// GET /api/admin/summary
router.get('/admin/summary', ...adminOnly, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { rows } = await pool.query(
            `WITH active AS (SELECT id, name, (end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' <= now() AS ready_to_close
                             FROM semesters WHERE status = 'active' LIMIT 1),
                  programmes_needing AS (
                      SELECT p.id,
                             NOT EXISTS (SELECT 1 FROM users r WHERE r.role = 'reviewer' AND r.deactivated_at IS NULL AND r.programme_id = p.id) AS no_reviewer,
                             NOT EXISTS (SELECT 1 FROM courses c, active WHERE c.programme_id = p.id AND c.semester_id = active.id AND c.status = 'active') AS no_courses
                      FROM programmes p WHERE p.status = 'active')
             SELECT (SELECT row_to_json(active) FROM active) AS active_semester,
                    (SELECT count(*)::int FROM applications a, active WHERE a.semester_id = active.id AND a.status = 'pending') AS pending,
                    (SELECT count(*)::int FROM applications a, active WHERE a.semester_id = active.id AND a.status = 'needs_info') AS needs_info,
                    (SELECT count(*)::int FROM programmes_needing WHERE no_reviewer) AS programmes_without_reviewer,
                    (SELECT count(*)::int FROM programmes_needing WHERE no_courses) AS programmes_without_courses,
                    (SELECT count(*)::int FROM allowed_domains) AS domains,
                    (SELECT count(*)::int FROM late_access l, active WHERE l.semester_id = active.id AND l.revoked_at IS NULL AND l.deadline > now()) AS late_access_active,
                    (SELECT count(*)::int FROM semesters WHERE status = 'setup') AS setup_semesters`
        );
        const r = rows[0];
        res.json({
            success: true,
            summary: {
                activeSemester: r.active_semester && { id: r.active_semester.id, name: r.active_semester.name },
                // The active semester's last day has passed: the admin can close it (admin round Group 6)
                readyToClose: !!r.active_semester?.ready_to_close,
                pending: r.pending,
                needsInfo: r.needs_info,
                programmesWithoutReviewer: r.programmes_without_reviewer,
                programmesWithoutCourses: r.active_semester ? r.programmes_without_courses : 0,
                domains: r.domains,
                lateAccessActive: r.late_access_active,
                setupSemesters: r.setup_semesters,
            },
        });
    } catch (err) {
        console.error('❌ Admin summary error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not load the summary');
    }
});

module.exports = router;
