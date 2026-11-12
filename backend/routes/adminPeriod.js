const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { requireIdParam, positiveInt } = require('../utils/validate');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const sendEmail = require('../utils/sendEmail');
const { buildAccountEmail, normalizeLanguage } = require('../utils/emailTemplates');
const { FRONTEND_URL } = require('../config/urls');
const { normalizeEmail } = require('../utils/rateLimit');
const { isAllowedStudentEmail } = require('../utils/domains');
const { isValidInviteEmail } = require('../utils/staffInvites');
const { REVIEW_MARGIN_DAYS, reviewSoonSql, committeeSoonSql } = require('../utils/semesters');
const { periodFor } = require('../utils/applicationPeriod');
const { programmeHasReviewerSql } = require('../utils/reviewers');

// The application period's controls (admin round Group 5; round 2 Group 1: several semesters in
// progress), superadmin only: Close now / Reopen until on a semester in progress (they change its
// closing time; the period rule in utils/applicationPeriod.js does the rest), late access, and the
// admin menu's summary. Times from the screen are Budapest wall-clock times ("2026-12-01T23:59").
//
// Reopen until and a late access deadline may run up to the semester's REVIEW deadline, not later.
// Both may move the review deadline in the same step (review_end_at), which is how the screen
// offers it when the new end leaves less than REVIEW_MARGIN_DAYS for reviewing. Reopen until
// moves the semester's application close, so the database also refuses it when it would overlap
// the next semester's application period; late access belongs to its own semester and may overlap
// the next period's opening.

const adminOnly = [verifyToken, requireRole('superadmin')];
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_REASON = 300;
const MAX_EMAILS = 100;

const isLocalTime = (value) => {
    if (typeof value !== 'string' || !LOCAL_TIME.test(value)) return false;
    const date = new Date(`${value}:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 16) === value;
};

// A semester (locked inside a transaction), with what the controls need to know
const activeSemester = (db, id, { lock = false } = {}) => db.query(
    `SELECT s.id, s.name, s.status, s.applications_open_at <= now() AS started, s.applications_close_at <= now() AS period_over,
            s.review_end_at
     FROM semesters s WHERE s.id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id]
).then((r) => r.rows[0]);

/**
 * Checks a new end (Reopen until, a late access deadline) against the review deadline, and an
 * optional new review deadline sent with it. Inside the caller's transaction.
 * @returns {{ at, reviewAt, tight } | { error: [status, code, message, field] }}
 *   tight: fewer than REVIEW_MARGIN_DAYS days are left for reviewing after the new end
 */
const checkNewEnd = async (client, semester, value, field, newReview) => {
    if (newReview !== undefined && newReview !== null && !isLocalTime(newReview)) return { error: [400, 'INVALID_TIME', 'review_end_at must be a date and time', 'review_end_at'] };
    const check = (await client.query(
        `SELECT ($1::timestamp AT TIME ZONE 'Europe/Budapest') AS at,
                ($1::timestamp AT TIME ZONE 'Europe/Budapest') > now() AS future,
                COALESCE($2::timestamp AT TIME ZONE 'Europe/Budapest', $3::timestamptz) AS review_at`,
        [value, newReview ?? null, semester.review_end_at]
    )).rows[0];
    if (!check.future) return { error: [400, 'TIME_NOT_IN_FUTURE', 'The new time must be in the future', field] };
    if (check.at > check.review_at) {
        return { error: [400, 'AFTER_REVIEW_DEADLINE', 'This is after the review deadline: move the review deadline too', field] };
    }
    const tight = (check.review_at - check.at) < REVIEW_MARGIN_DAYS * 24 * 60 * 60 * 1000;
    return { at: check.at, reviewAt: check.review_at, tight };
};

// ---------------------------------------------------------------------------------------------
// Close now and Reopen until
// ---------------------------------------------------------------------------------------------

// POST /api/admin/semesters/:id/close-now { reason? }: ends the period at once (a semester in
// progress, while its period runs). The reason is shown to students.
router.post('/admin/semesters/:id/close-now', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (req.body?.reason !== undefined && typeof req.body.reason !== 'string') return sendError(res, 400, 'INVALID_REASON', 'reason must be text', { field: 'reason' });
    if (reason.length > MAX_REASON) return sendError(res, 400, 'REASON_TOO_LONG', `At most ${MAX_REASON} characters`, { field: 'reason' });
    try {
        const result = await inTransaction(async (client) => {
            const s = await activeSemester(client, req.ids.id, { lock: true });
            if (!s) return { error: [404, 'SEMESTER_NOT_FOUND', 'Semester not found'] };
            if (s.status !== 'active') return { error: [409, 'SEMESTER_NOT_ACTIVE', 'Only a semester in progress has an application period to close'] };
            if (!s.started || s.period_over) return { error: [409, 'PERIOD_NOT_OPEN', 'The application period is not open right now'] };
            // close_reason: '' = closed by the admin without a reason (NULL = closed by its dates).
            // The earlier of the database's clock and the server's: the period is judged by the server's
            // clock (utils/applicationPeriod.js), so a database clock a few ms ahead must not keep it open.
            await client.query('UPDATE semesters SET applications_close_at = LEAST(now(), $3::timestamptz), close_reason = $2 WHERE id = $1', [s.id, reason, new Date()]);
            return {};
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2]);
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Close now error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not close the application period');
    }
});

// POST /api/admin/semesters/:id/reopen { until, review_end_at? }: open again for everyone until a
// new closing time in the future, at the latest the review deadline (review_end_at moves that in
// the same step). The Close now reason is cleared. Refused when it would overlap the next
// semester's application period. tight: true in the answer when fewer than REVIEW_MARGIN_DAYS are
// left for reviewing.
router.post('/admin/semesters/:id/reopen', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const until = req.body?.until;
    if (!isLocalTime(until)) return sendError(res, 400, 'INVALID_TIME', 'until must be a date and time', { field: 'until' });
    try {
        const result = await inTransaction(async (client) => {
            const s = await activeSemester(client, req.ids.id, { lock: true });
            if (!s) return { error: [404, 'SEMESTER_NOT_FOUND', 'Semester not found'] };
            if (s.status !== 'active') return { error: [409, 'SEMESTER_NOT_ACTIVE', 'Only a semester in progress can be reopened'] };
            if (!s.started) return { error: [409, 'PERIOD_NOT_STARTED', 'The period has not started yet: change its dates instead'] };
            const end = await checkNewEnd(client, s, until, 'until', req.body?.review_end_at);
            if (end.error) return end;
            await client.query(
                'UPDATE semesters SET applications_close_at = $2, review_end_at = $3, close_reason = NULL WHERE id = $1',
                [s.id, end.at, end.reviewAt]
            );
            return { tight: end.tight };
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2], { field: result.error[3] });
        return res.json({ success: true, tight: result.tight });
    } catch (err) {
        if (err.code === '23P01') return sendError(res, 409, 'PERIODS_OVERLAP', 'This would overlap the next semester\'s application period', { field: 'until' });
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

// The semesters in progress that late access can be given for, newest period first
const SEMESTERS_IN_PROGRESS = `
    SELECT id, name, applications_open_at AS opens_at, applications_close_at AS closes_at, review_end_at
    FROM semesters WHERE status = 'active' ORDER BY applications_open_at DESC`;

/**
 * The semester late access is for: ?semester_id= / semester_id (a semester in progress), or by
 * default the newest one whose period has started (else the first one in progress).
 */
const lateAccessSemester = async (db, value, inProgress) => {
    if (value !== undefined && value !== null && value !== '') {
        const id = positiveInt(value);
        const found = inProgress.find((s) => s.id === id);
        return found ? { semester: found } : { error: [404, 'SEMESTER_NOT_FOUND', 'Not a semester in progress', 'semester_id'] };
    }
    const started = inProgress.find((s) => new Date(s.opens_at) <= new Date());
    return { semester: started || inProgress[inProgress.length - 1] || null };
};

// GET /api/admin/late-access[?semester_id=]: a semester's late access, newest first, and the
// semesters in progress to choose from
router.get('/admin/late-access', ...adminOnly, async (req, res) => {
    try {
        const inProgress = (await pool.query(SEMESTERS_IN_PROGRESS)).rows;
        const chosen = await lateAccessSemester(pool, req.query.semester_id, inProgress);
        if (chosen.error) return sendError(res, chosen.error[0], chosen.error[1], chosen.error[2], { field: chosen.error[3] });
        if (!chosen.semester) return res.json({ success: true, semesters: [], semester: null, grants: [], reviewMarginDays: REVIEW_MARGIN_DAYS });
        const { rows } = await pool.query(
            `SELECT ${LATE_COLUMNS} FROM late_access l LEFT JOIN users g ON g.id = l.granted_by LEFT JOIN users r ON r.id = l.revoked_by
             WHERE l.semester_id = $1 ORDER BY l.created_at DESC, l.id DESC`,
            [chosen.semester.id]
        );
        res.json({ success: true, semesters: inProgress, semester: chosen.semester, grants: rows, reviewMarginDays: REVIEW_MARGIN_DAYS });
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

// POST /api/admin/late-access { emails: "a@x, b@y" | [..], deadline, language?, semester_id?, review_end_at? }
// For a semester in progress (default as in GET). The deadline: in the future, at the latest the
// review deadline (review_end_at moves that in the same step). Each address is checked on its own;
// a bad one doesn't stop the others. Granting again to the same address replaces its earlier grant.
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
            const inProgress = (await client.query(SEMESTERS_IN_PROGRESS)).rows;
            const chosen = await lateAccessSemester(client, req.body?.semester_id, inProgress);
            if (chosen.error) return { error: chosen.error };
            if (!chosen.semester) return { error: [409, 'NO_ACTIVE_SEMESTER', 'There is no semester in progress'] };
            const semesterId = chosen.semester.id;
            const s = await activeSemester(client, semesterId, { lock: true });
            if (s.status !== 'active') return { error: [409, 'SEMESTER_NOT_ACTIVE', 'Only a semester in progress can give late access'] };
            const check = await checkNewEnd(client, s, deadline, 'deadline', req.body?.review_end_at);
            if (check.error) return { error: check.error };
            if (check.reviewAt.getTime() !== new Date(s.review_end_at).getTime()) {
                await client.query('UPDATE semesters SET review_end_at = $2 WHERE id = $1', [semesterId, check.reviewAt]);
            }

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
            return { results, toEmail, tight: check.tight };
        });
        if (outcome.error) return sendError(res, outcome.error[0], outcome.error[1], outcome.error[2], { field: outcome.error[3] });
        res.status(201).json({ success: true, results: outcome.results, tight: outcome.tight });
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

// GET /api/admin/summary: the badges and the Overview. Several semesters can be in progress
// (round 2 Group 1), so the semester facts are a list, one entry per semester in progress:
//   periodOpen, reviewSoon (the review deadline is within REVIEW_WARNING_DAYS and something is
//   undecided), reviewPassed (with the undecided counts per programme: nothing was rejected),
//   canClose (period over, no late access running, nothing undecided).
// programmesWithoutCourses: for the semester the application period rule talks about (the open
// or coming period), since that is the catalogue students choose from.
router.get('/admin/summary', ...adminOnly, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const period = await periodFor(pool);
        const catalogueSemester = period.semester ? period.semester.id : null;
        const semesters = (await pool.query(
            `SELECT sb.id, sb.name, sb.opens_at, sb.closes_at, sb.review_ends_at, sb.committee_ends_at,
                    sb.committee_ends_at <= now() AS committee_passed,
                    ${committeeSoonSql('sb', 'now()')} AND sb.committee_ends_at > now() AS committee_soon,
                    sb.opens_at <= now() AND sb.closes_at > now() AS period_open,
                    sb.closes_at <= now() AS period_over,
                    sb.review_ends_at <= now() AS review_passed,
                    ${reviewSoonSql('sb', 'now()')} AND sb.review_ends_at > now() AS review_soon,
                    (SELECT count(*)::int FROM applications a WHERE a.semester_id = sb.id AND a.status = 'pending') AS pending,
                    (SELECT count(*)::int FROM applications a WHERE a.semester_id = sb.id AND a.status = 'needs_info') AS needs_info,
                    (SELECT count(*)::int FROM applications a WHERE a.semester_id = sb.id AND a.status = 'awaiting_committee') AS awaiting_committee,
                    (SELECT count(*)::int FROM late_access l WHERE l.semester_id = sb.id AND l.revoked_at IS NULL AND l.deadline > now()) AS late_access,
                    COALESCE((SELECT json_agg(x ORDER BY x.code) FROM (
                        SELECT p.code, p.name_en, p.name_hu, p.name_de,
                               count(*) FILTER (WHERE a.status = 'pending')::int AS pending,
                               count(*) FILTER (WHERE a.status = 'needs_info')::int AS needs_info
                        FROM applications a JOIN programmes p ON p.id = a.programme_id
                        WHERE a.semester_id = sb.id AND a.status IN ('pending', 'needs_info')
                        GROUP BY p.id) x), '[]') AS undecided_by_programme,
                    -- awaiting the committee, per programme (round 2 Group 2)
                    COALESCE((SELECT json_agg(x ORDER BY x.code) FROM (
                        SELECT p.code, p.name_en, p.name_hu, p.name_de, count(*)::int AS awaiting
                        FROM applications a JOIN programmes p ON p.id = a.programme_id
                        WHERE a.semester_id = sb.id AND a.status = 'awaiting_committee'
                        GROUP BY p.id) x), '[]') AS awaiting_by_programme
             FROM semester_bounds sb WHERE sb.status = 'active'
             ORDER BY sb.opens_at`
        )).rows.map((r) => {
            const undecided = r.pending + r.needs_info;
            return {
                id: r.id, name: r.name, opensAt: r.opens_at, closesAt: r.closes_at, reviewEndsAt: r.review_ends_at,
                periodOpen: r.period_open, pending: r.pending, needsInfo: r.needs_info, awaitingCommittee: r.awaiting_committee, lateAccess: r.late_access,
                reviewSoon: r.review_soon && undecided > 0,
                reviewPassed: r.review_passed && undecided > 0,
                undecidedByProgramme: r.review_passed ? r.undecided_by_programme : [],
                awaitingByProgramme: r.awaiting_by_programme,
                // The committee deadline (round 2 Group 2): soon / passed only while something awaits the committee
                committeeEndsAt: r.committee_ends_at,
                committeeSoon: r.committee_soon && r.awaiting_committee > 0,
                committeePassed: r.committee_passed && r.awaiting_committee > 0,
                // nothing undecided and nothing awaiting the committee (round 2 Group 2)
                canClose: r.period_over && r.late_access === 0 && undecided === 0 && r.awaiting_committee === 0,
            };
        });
        const { rows } = await pool.query(
            `WITH programmes_needing AS (
                 SELECT p.id,
                        NOT ${programmeHasReviewerSql('p.id')} AS no_reviewer,
                        -- no main reviewer, but an extra reviewer still assisting (round 2 Group 1)
                        ${programmeHasReviewerSql('p.id')} AND NOT EXISTS (
                            SELECT 1 FROM staff_programmes m JOIN users mu ON mu.id = m.user_id AND mu.deactivated_at IS NULL
                            WHERE m.programme_id = p.id AND m.role = 'main' AND m.ended_at IS NULL) AS no_main,
                        NOT EXISTS (SELECT 1 FROM courses c WHERE c.programme_id = p.id AND c.semester_id = $1 AND c.status = 'active') AS no_courses
                 FROM programmes p WHERE p.status = 'active')
             SELECT (SELECT count(*)::int FROM programmes_needing WHERE no_reviewer) AS programmes_without_reviewer,
                    (SELECT count(*)::int FROM programmes_needing WHERE no_main) AS programmes_without_main,
                    (SELECT count(*)::int FROM programmes_needing WHERE no_courses) AS programmes_without_courses,
                    (SELECT count(*)::int FROM allowed_domains) AS domains,
                    (SELECT count(*)::int FROM semesters WHERE status = 'setup') AS setup_semesters`,
            [catalogueSemester]
        );
        const r = rows[0];
        const sum = (key) => semesters.reduce((total, sem) => total + sem[key], 0);
        res.json({
            success: true,
            summary: {
                semesters,
                // The first semester in progress (null: none in progress, the Semester badge says "!")
                activeSemester: semesters[0] ? { id: semesters[0].id, name: semesters[0].name } : null,
                readyToClose: semesters.some((sem) => sem.canClose),
                pending: sum('pending'),
                needsInfo: sum('needsInfo'),
                awaitingCommittee: sum('awaitingCommittee'),
                programmesWithoutReviewer: r.programmes_without_reviewer,
                // An assisting extra reviewer keeps working, but the admin should choose a main reviewer
                programmesWithoutMain: r.programmes_without_main,
                programmesWithoutCourses: catalogueSemester ? r.programmes_without_courses : 0,
                catalogueSemester: period.semester ? { id: period.semester.id, name: period.semester.name } : null,
                domains: r.domains,
                lateAccessActive: sum('lateAccess'),
                setupSemesters: r.setup_semesters,
            },
        });
    } catch (err) {
        console.error('❌ Admin summary error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not load the summary');
    }
});

module.exports = router;
