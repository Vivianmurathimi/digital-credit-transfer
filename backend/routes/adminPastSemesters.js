const express = require('express');
const router = express.Router();
const pool = require('../db');
const minioClient = require('../minio');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { requireIdParam } = require('../utils/validate');
const sendError = require('../utils/sendError');
const { ARCHIVE_BUCKET } = require('../config/buckets');
const { normalizeLanguage, statusLabels, reasons } = require('../utils/emailTemplates');
const { closePreview, closeSemester, generateSemesterBook } = require('../utils/semesterClose');
const { loadApplicationDetails } = require('../utils/applicationDetails');
const { budapest, sendCsv } = require('../utils/csv');

// Closing a semester and the Past semesters section (admin round Group 6), superadmin only.

const adminOnly = [verifyToken, requireRole('superadmin')];
const STATUSES = ['pending', 'needs_info', 'approved', 'rejected', 'withdrawn'];
const PAGE_SIZE = 200;
const EXPORT_LIMIT = 10000;

// ---------------------------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------------------------

// GET /api/admin/semesters/:id/close-preview: what closing would do now (saves nothing)
router.get('/admin/semesters/:id/close-preview', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        const preview = await closePreview(pool, req.ids.id);
        if (!preview) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'Semester not found');
        res.json({ success: true, preview });
    } catch (err) {
        console.error('❌ Close preview error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not prepare the close');
    }
});

// POST /api/admin/semesters/:id/close { confirm_name }: once the period is over, no late access runs and
// nothing is undecided (utils/semesterClose.js), the name typed exactly.
// The answer includes the real counts, the emails sent and the PDF book (or its error).
router.post('/admin/semesters/:id/close', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        const result = await closeSemester({ semesterId: req.ids.id, adminId: req.actor.id, confirmName: req.body?.confirm_name });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2], { field: result.error[3] });
        res.json({ success: true, summary: result.summary });
    } catch (err) {
        console.error('❌ Close semester error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not close the semester');
    }
});

// ---------------------------------------------------------------------------------------------
// Past semesters
// ---------------------------------------------------------------------------------------------

// GET /api/admin/past-semesters: the closed semesters, newest first, with counts and the PDF book
router.get('/admin/past-semesters', ...adminOnly, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT s.id, s.name, to_char(s.end_date, 'YYYY-MM-DD') AS end_date, s.closed_at, closer.name AS closed_by_name,
                    s.book_name IS NOT NULL AS has_book, s.book_generated_at, s.book_error,
                    (SELECT count(*)::int FROM applications a WHERE a.semester_id = s.id) AS applications
             FROM semesters s LEFT JOIN users closer ON closer.id = s.closed_by
             WHERE s.status = 'closed' ORDER BY s.end_date DESC`
        );
        res.json({ success: true, semesters: rows });
    } catch (err) {
        console.error('❌ Past semesters error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list the past semesters');
    }
});

const closedSemester = async (id) => (await pool.query("SELECT id, name, book_name FROM semesters WHERE id = $1 AND status = 'closed'", [id])).rows[0];

// The search: student name, email, Neptun code, or course (code or name); optional status.
// Returns [error] or [null, sql, params].
const searchQuery = (semesterId, query) => {
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const status = query.status || null;
    if (q.length > 100) return [['INVALID_SEARCH', 'At most 100 characters', 'q']];
    if (status !== null && !STATUSES.includes(status)) return [['INVALID_STATUS', 'Unknown status', 'status']];
    const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    return [null, `
        FROM applications a
        JOIN users u ON u.id = a.student_id
        JOIN programmes p ON p.id = a.programme_id
        LEFT JOIN users d ON d.id = a.decided_by
        WHERE a.semester_id = $1 AND ($2::text IS NULL OR a.status = $2)
          AND ($3::text IS NULL OR u.name ILIKE $3 OR u.email ILIKE $3 OR u.neptun_code ILIKE $3
               OR a.target_course_code ILIKE $3 OR a.target_courses->0->>'course_name' ILIKE $3)`,
    [semesterId, status, pattern]];
};
const LIST_COLUMNS = `a.id, a.status, a.created_at AT TIME ZONE 'UTC' AS submitted_at, u.name AS student_name, u.email AS student_email,
    u.neptun_code, p.code AS programme_code, a.target_course_code, a.target_courses->0->>'course_name' AS target_course_name,
    (a.target_courses->0->>'credits')::int AS credits, a.final_grade, a.decided_by_role,
    CASE WHEN a.decided_by_role = 'reviewer' THEN d.name END AS decided_by_name, a.decided_at, a.decision_rationale,
    (SELECT e.reason_code FROM application_events e WHERE e.application_id = a.id AND e.reason_code IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS reason_code`;

// GET /api/admin/past-semesters/:id/applications?q=&status=&offset=
router.get('/admin/past-semesters/:id/applications', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const [problem, from, params] = searchQuery(req.ids.id, req.query);
    if (problem) return sendError(res, 400, problem[0], problem[1], { field: problem[2] });
    const offset = req.query.offset === undefined ? 0 : (/^\d{1,9}$/.test(String(req.query.offset)) ? Number(req.query.offset) : null);
    if (offset === null) return sendError(res, 400, 'INVALID_OFFSET', 'offset must be a whole number', { field: 'offset' });
    try {
        if (!(await closedSemester(req.ids.id))) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'No closed semester with this id');
        const total = (await pool.query(`SELECT count(*)::int AS n ${from}`, params)).rows[0].n;
        const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} ${from} ORDER BY a.created_at, a.id LIMIT ${PAGE_SIZE} OFFSET ${offset}`, params);
        res.json({ success: true, total, offset, pageSize: PAGE_SIZE, applications: rows });
    } catch (err) {
        console.error('❌ Past semester search error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not search the applications');
    }
});

// GET /api/admin/past-semesters/:id/applications/:appId: one application, read-only
router.get('/admin/past-semesters/:id/applications/:appId', ...adminOnly, requireIdParam('id'), requireIdParam('appId'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        if (!(await closedSemester(req.ids.id))) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'No closed semester with this id');
        const application = await loadApplicationDetails(pool, req.ids.appId, { semesterId: req.ids.id, includeWithdrawn: true });
        if (!application) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        res.json({ success: true, application });
    } catch (err) {
        console.error('❌ Past semester application error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// CSV format: utils/csv.js
const CSV_HEADERS = {
    en: ['Application', 'Submitted', 'Student', 'Email', 'Neptun code', 'Programme', 'Course code', 'Course', 'Credits', 'Status', 'Final grade', 'Decided by', 'Decided at', 'Reason'],
    hu: ['Kérelem', 'Beküldve', 'Hallgató', 'E-mail', 'Neptun-kód', 'Szak', 'Tárgykód', 'Kurzus', 'Kredit', 'Állapot', 'Végső jegy', 'Döntött', 'Döntés ideje', 'Indoklás'],
    de: ['Antrag', 'Eingereicht', 'Studierende/r', 'E-Mail', 'Neptun-Code', 'Studiengang', 'Kurscode', 'Kurs', 'Credits', 'Status', 'Endnote', 'Entschieden von', 'Entschieden am', 'Begründung'],
};
const DECIDERS = { en: { admin: 'Admin', system: 'System' }, hu: { admin: 'Admin', system: 'Rendszer' }, de: { admin: 'Admin', system: 'System' } };

// GET /api/admin/past-semesters/:id/export.csv?q=&status=&lang=: the search results as CSV
router.get('/admin/past-semesters/:id/export.csv', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const [problem, from, params] = searchQuery(req.ids.id, req.query);
    if (problem) return sendError(res, 400, problem[0], problem[1], { field: problem[2] });
    const lang = normalizeLanguage(req.query.lang);
    try {
        const semester = await closedSemester(req.ids.id);
        if (!semester) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'No closed semester with this id');
        const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} ${from} ORDER BY a.created_at, a.id LIMIT ${EXPORT_LIMIT}`, params);
        const lines = [CSV_HEADERS[lang]];
        for (const r of rows) {
            const decider = r.decided_by_role === 'reviewer' ? r.decided_by_name : DECIDERS[lang][r.decided_by_role] || '';
            const reason = r.decision_rationale || (r.reason_code ? reasons[lang]?.[r.reason_code] || r.reason_code : '');
            lines.push([
                r.id, budapest(r.submitted_at), r.student_name, r.student_email,
                r.neptun_code, r.programme_code, r.target_course_code, r.target_course_name, r.credits,
                statusLabels[lang][r.status] || r.status, r.final_grade, decider, budapest(r.decided_at), reason,
            ]);
        }
        sendCsv(res, `applications-${semester.name}.csv`, lines);
    } catch (err) {
        console.error('❌ Past semester export error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not export the applications');
    }
});

// GET /api/admin/past-semesters/:id/book: the semester's PDF book
router.get('/admin/past-semesters/:id/book', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        const semester = await closedSemester(req.ids.id);
        if (!semester) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'No closed semester with this id');
        if (!semester.book_name) return sendError(res, 404, 'BOOK_NOT_FOUND', 'This semester has no PDF book yet: generate it');
        const stat = await minioClient.statObject(ARCHIVE_BUCKET, semester.book_name);
        const stream = await minioClient.getObject(ARCHIVE_BUCKET, semester.book_name);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${semester.book_name}"`);
        stream.on('error', (err) => { console.error('❌ Semester book stream failed:', err.message); res.destroy(err); });
        return stream.pipe(res);
    } catch (err) {
        if (err.code === 'NotFound' || err.code === 'NoSuchKey') return sendError(res, 404, 'BOOK_NOT_FOUND', 'The PDF book is missing: generate it again');
        console.error('❌ Semester book download error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not download the PDF book');
    }
});

// POST /api/admin/past-semesters/:id/book: generate the PDF book (again), without reopening anything
router.post('/admin/past-semesters/:id/book', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        if (!(await closedSemester(req.ids.id))) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'No closed semester with this id');
        const result = await generateSemesterBook(req.ids.id, { generatedBy: req.actor.id });
        if (result.error) return sendError(res, 500, 'BOOK_FAILED', `The PDF book could not be generated: ${result.error}`);
        return res.json({ success: true, book: result.name });
    } catch (err) {
        console.error('❌ Generate semester book error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not generate the PDF book');
    }
});

module.exports = router;
