const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { requireIdParam, positiveInt } = require('../utils/validate');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const { readNeptunFile, buildPreview, applyImport, programmeBlockers, courseBlockers, courseUsageSql } = require('../utils/neptun/catalogue');
const { MAX_BYTES } = require('../utils/neptun/parse');

// Semesters and the catalogue (admin round Group 4), superadmin only.
// Times come from the screen as Budapest wall-clock times ("2026-09-01T08:00") and are stored in
// UTC; they are sent back as UTC (ISO) and shown in Budapest time.

const adminOnly = [verifyToken, requireRole('superadmin')];
const MAX_NAME = 50;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A real Budapest wall-clock time "YYYY-MM-DDTHH:mm" (2026-02-30T10:00 and 25:00 are refused)
const isLocalTime = (value) => {
    if (typeof value !== 'string' || !LOCAL_TIME.test(value)) return false;
    const date = new Date(`${value}:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 16) === value;
};
const isDay = (value) => typeof value === 'string' && DAY.test(value) && isLocalTime(`${value}T00:00`);

const SEMESTER_COLUMNS = `
    s.id, s.name, s.status, s.applications_open_at AS opens_at, s.applications_close_at AS closes_at,
    to_char(s.end_date, 'YYYY-MM-DD') AS end_date, s.closed_at, closer.name AS closed_by_name, s.created_at,
    (SELECT count(*)::int FROM applications a WHERE a.semester_id = s.id) AS applications,
    (SELECT count(*)::int FROM courses c WHERE c.semester_id = s.id) AS courses`;
const readSemester = async (db, id) => (await db.query(
    `SELECT ${SEMESTER_COLUMNS} FROM semesters s LEFT JOIN users closer ON closer.id = s.closed_by WHERE s.id = $1`, [id]
)).rows[0];

// The checks shared by create and edit; returns [code, message, field] or null
const checkSemesterInput = ({ name, opens_at: opensAt, closes_at: closesAt, end_date: endDate }) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME) return ['INVALID_SEMESTER_NAME', `A name of 1 to ${MAX_NAME} characters`, 'name'];
    if (!isLocalTime(opensAt)) return ['INVALID_TIME', 'Opening time must be a date and time', 'opens_at'];
    if (!isLocalTime(closesAt)) return ['INVALID_TIME', 'Closing time must be a date and time', 'closes_at'];
    if (!isDay(endDate)) return ['INVALID_DATE', 'The last day must be a date', 'end_date'];
    if (closesAt <= opensAt) return ['CLOSE_BEFORE_OPEN', 'Closing must be after opening', 'closes_at'];
    if (closesAt.slice(0, 10) > endDate) return ['END_BEFORE_CLOSE', 'The semester cannot end before applications close', 'end_date'];
    return null;
};

// Database refusals of a semester save, as answers
const semesterSaveError = (err) => {
    if (err.code === '23505' && err.constraint === 'semesters_name_key') return [409, 'SEMESTER_NAME_TAKEN', 'A semester with this name already exists', 'name'];
    if (err.code === '23P01') return [409, 'SEMESTERS_OVERLAP', 'These dates overlap another semester', 'opens_at'];
    if (err.code === '23514') return [400, 'CLOSE_BEFORE_OPEN', 'The times are out of order', 'closes_at'];
    return null;
};

// ---------------------------------------------------------------------------------------------
// Semesters
// ---------------------------------------------------------------------------------------------

// GET /api/admin/semesters: every semester, newest first
router.get('/admin/semesters', ...adminOnly, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT ${SEMESTER_COLUMNS} FROM semesters s LEFT JOIN users closer ON closer.id = s.closed_by
             ORDER BY s.applications_open_at DESC`
        );
        res.json({ success: true, semesters: rows });
    } catch (err) {
        console.error('❌ Semester list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list the semesters');
    }
});

// POST /api/admin/semesters { name, opens_at, closes_at, end_date }: a new semester in setup
router.post('/admin/semesters', ...adminOnly, async (req, res) => {
    const body = req.body || {};
    const problem = checkSemesterInput(body);
    if (problem) return sendError(res, 400, problem[0], problem[1], { field: problem[2] });
    try {
        const { rows } = await pool.query(
            `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, end_date)
             VALUES ($1, 'setup', $2::timestamp AT TIME ZONE 'Europe/Budapest', $3::timestamp AT TIME ZONE 'Europe/Budapest', $4::date)
             RETURNING id`,
            [body.name.trim(), body.opens_at, body.closes_at, body.end_date]
        );
        res.status(201).json({ success: true, semester: await readSemester(pool, rows[0].id) });
    } catch (err) {
        const known = semesterSaveError(err);
        if (known) return sendError(res, known[0], known[1], known[2], { field: known[3] });
        console.error('❌ Create semester error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not create the semester');
    }
});

// PUT /api/admin/semesters/:id { name, opens_at, closes_at, end_date }: not for a closed semester
router.put('/admin/semesters/:id', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const body = req.body || {};
    const problem = checkSemesterInput(body);
    if (problem) return sendError(res, 400, problem[0], problem[1], { field: problem[2] });
    try {
        const { rowCount } = await pool.query(
            `UPDATE semesters SET name = $2, applications_open_at = $3::timestamp AT TIME ZONE 'Europe/Budapest',
                 applications_close_at = $4::timestamp AT TIME ZONE 'Europe/Budapest', end_date = $5::date
             WHERE id = $1 AND status <> 'closed'`,
            [req.ids.id, body.name.trim(), body.opens_at, body.closes_at, body.end_date]
        );
        if (rowCount === 0) {
            const exists = (await pool.query('SELECT status FROM semesters WHERE id = $1', [req.ids.id])).rows[0];
            return exists
                ? sendError(res, 409, 'SEMESTER_CLOSED', 'A closed semester cannot be changed')
                : sendError(res, 404, 'SEMESTER_NOT_FOUND', 'Semester not found');
        }
        res.json({ success: true, semester: await readSemester(pool, req.ids.id) });
    } catch (err) {
        const known = semesterSaveError(err);
        if (known) return sendError(res, known[0], known[1], known[2], { field: known[3] });
        console.error('❌ Edit semester error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not save the semester');
    }
});

// What to fix before opening: active programmes with no active course in the semester, or no
// active reviewer. Shown in the Activate confirmation; they do not block it.
const semesterWarnings = async (db, semesterId) => (await db.query(
    `SELECT p.code, p.name_en, p.name_hu, p.name_de,
            NOT EXISTS (SELECT 1 FROM courses c WHERE c.programme_id = p.id AND c.semester_id = $1 AND c.status = 'active') AS no_courses,
            NOT EXISTS (SELECT 1 FROM users r WHERE r.role = 'reviewer' AND r.deactivated_at IS NULL AND r.programme_id = p.id) AS no_reviewer
     FROM programmes p WHERE p.status = 'active' ORDER BY p.code`,
    [semesterId]
)).rows.filter((p) => p.no_courses || p.no_reviewer);

// GET /api/admin/semesters/:id/warnings
router.get('/admin/semesters/:id/warnings', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        if (!(await readSemester(pool, req.ids.id))) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'Semester not found');
        res.json({ success: true, warnings: await semesterWarnings(pool, req.ids.id) });
    } catch (err) {
        console.error('❌ Semester warnings error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not check the semester');
    }
});

// POST /api/admin/semesters/:id/activate: makes a setup semester the current one. Refused while
// another one is active (the database allows only one) and for a closed one.
router.post('/admin/semesters/:id/activate', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        const result = await inTransaction(async (client) => {
            const semester = (await client.query('SELECT id, status FROM semesters WHERE id = $1 FOR UPDATE', [req.ids.id])).rows[0];
            if (!semester) return { error: [404, 'SEMESTER_NOT_FOUND', 'Semester not found'] };
            if (semester.status === 'active') return { error: [409, 'ALREADY_ACTIVE', 'This semester is already active'] };
            if (semester.status === 'closed') return { error: [409, 'SEMESTER_CLOSED', 'A closed semester cannot be activated'] };
            const other = (await client.query("SELECT name FROM semesters WHERE status = 'active' AND id <> $1", [semester.id])).rows[0];
            if (other) return { error: [409, 'ANOTHER_SEMESTER_ACTIVE', `"${other.name}" is still active`] };
            await client.query("UPDATE semesters SET status = 'active' WHERE id = $1", [semester.id]);
            return { warnings: await semesterWarnings(client, semester.id) };
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2]);
        res.json({ success: true, semester: await readSemester(pool, req.ids.id), warnings: result.warnings });
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'semesters_one_active') return sendError(res, 409, 'ANOTHER_SEMESTER_ACTIVE', 'Another semester is still active');
        console.error('❌ Activate semester error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not activate the semester');
    }
});

// ---------------------------------------------------------------------------------------------
// Neptun import: preview (saves nothing), then import (one transaction)
// ---------------------------------------------------------------------------------------------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
const receiveCsv = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return sendError(res, 400, 'CSV_TOO_LARGE', 'The file is larger than 2 MB', { field: 'file' });
    if (err) return sendError(res, 400, 'INVALID_FILE', 'Upload one CSV file in the field "file"', { field: 'file' });
    if (!req.file) return sendError(res, 400, 'NO_FILE', 'Choose a CSV file', { field: 'file' });
    return next();
});

// The semester to import into: setup or active (a closed one is read-only)
const importSemester = async (db, value, { lock = false } = {}) => {
    const id = positiveInt(value);
    if (id === null) return { error: [400, 'INVALID_ID', 'Choose a semester', 'semester_id'] };
    const semester = (await db.query(`SELECT id, name, status FROM semesters WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!semester) return { error: [404, 'SEMESTER_NOT_FOUND', 'Semester not found', 'semester_id'] };
    if (semester.status === 'closed') return { error: [409, 'SEMESTER_CLOSED', 'A closed semester cannot be changed', 'semester_id'] };
    return { semester };
};

const fileProblem = (file) => (file.fileError ? [400, file.fileError.code, file.fileError.message, 'file'] : null);

// POST /api/admin/catalogue/preview (multipart: file, semester_id)
router.post('/admin/catalogue/preview', ...adminOnly, receiveCsv, async (req, res) => {
    try {
        const { semester, error } = await importSemester(pool, req.body.semester_id);
        if (error) return sendError(res, error[0], error[1], error[2], { field: error[3] });
        const file = readNeptunFile(req.file.buffer);
        const problem = fileProblem(file);
        if (problem) return sendError(res, problem[0], problem[1], problem[2], { field: problem[3] });
        res.json({ success: true, semester, preview: await buildPreview(pool, semester.id, file) });
    } catch (err) {
        console.error('❌ Import preview error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not read the file');
    }
});

// POST /api/admin/catalogue/import (multipart: file, semester_id, hash, decisions as JSON text)
// The same file again: its hash must match the preview the admin confirmed.
router.post('/admin/catalogue/import', ...adminOnly, receiveCsv, async (req, res) => {
    let decisions = {};
    try {
        decisions = req.body.decisions ? JSON.parse(req.body.decisions) : {};
        if (typeof decisions !== 'object' || decisions === null || Array.isArray(decisions)) throw new Error('not an object');
    } catch {
        return sendError(res, 400, 'INVALID_DECISIONS', 'decisions must be a JSON object', { field: 'decisions' });
    }
    const file = readNeptunFile(req.file.buffer);
    const problem = fileProblem(file);
    if (problem) return sendError(res, problem[0], problem[1], problem[2], { field: problem[3] });
    if (req.body.hash !== file.hash) return sendError(res, 409, 'PREVIEW_MISMATCH', 'This is not the file that was previewed: preview it again', { field: 'file' });
    try {
        const result = await inTransaction(async (client) => {
            const { semester, error } = await importSemester(client, req.body.semester_id, { lock: true });
            if (error) return { error };
            // One import at a time (a second one waits for this one)
            await client.query("SELECT pg_advisory_xact_lock(hashtext('catalogue_import'))");
            return applyImport(client, semester.id, file, decisions);
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2], { field: result.error[3] });
        res.json({ success: true, summary: result.summary });
    } catch (err) {
        console.error('❌ Import error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not import the file');
    }
});

// ---------------------------------------------------------------------------------------------
// Programmes & Courses page
// ---------------------------------------------------------------------------------------------

// GET /api/admin/catalogue?semester_id=: programmes (with their students and applications) and
// that semester's courses (with their applications), with status and whether each can be deleted
router.get('/admin/catalogue', ...adminOnly, async (req, res) => {
    const semesterId = positiveInt(req.query.semester_id);
    if (semesterId === null) return sendError(res, 400, 'INVALID_ID', 'Choose a semester', { field: 'semester_id' });
    try {
        if (!(await readSemester(pool, semesterId))) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'Semester not found');
        const programmes = (await pool.query(
            `SELECT p.id, p.code, p.name_en, p.name_hu, p.name_de, p.status,
                    (SELECT count(*)::int FROM users u WHERE u.programme_id = p.id AND u.role = 'student') AS students,
                    (SELECT count(*)::int FROM applications a WHERE a.programme_id = p.id) AS applications
             FROM programmes p ORDER BY p.code`
        )).rows;
        for (const p of programmes) {
            p.blockedBy = await programmeBlockers(pool, p.id, semesterId);
            p.canDelete = p.blockedBy.length === 0;
        }
        const courses = (await pool.query(
            `SELECT c.id, c.course_code, c.course_name, c.credits, c.status, p.code AS programme_code, ${courseUsageSql}
             FROM courses c JOIN programmes p ON p.id = c.programme_id LEFT JOIN semester_bounds sb ON sb.id = c.semester_id
             WHERE c.semester_id = $1 ORDER BY p.code, c.course_code`,
            [semesterId]
        )).rows.map((c) => {
            const blockedBy = courseBlockers(c);
            return { ...c, blockedBy, canDelete: blockedBy.length === 0 };
        });
        // A programme can only be deleted when none of this semester's courses is in use either
        for (const p of programmes) {
            if (courses.some((c) => c.programme_code === p.code && !c.canDelete) && p.canDelete) {
                p.blockedBy.push('COURSES_IN_USE');
                p.canDelete = false;
            }
        }
        res.json({ success: true, programmes, courses });
    } catch (err) {
        console.error('❌ Catalogue error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not load the catalogue');
    }
});

const readStatus = (req, res) => {
    const status = req.body?.status;
    if (!['active', 'hidden'].includes(status)) {
        sendError(res, 400, 'INVALID_STATUS', 'status must be active or hidden', { field: 'status' });
        return null;
    }
    return status;
};

// PUT /api/admin/programmes/:id/status { status: active | hidden }: Hide keeps all data
router.put('/admin/programmes/:id/status', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const status = readStatus(req, res);
    if (!status) return undefined;
    try {
        const { rowCount } = await pool.query('UPDATE programmes SET status = $2 WHERE id = $1', [req.ids.id, status]);
        if (rowCount === 0) return sendError(res, 404, 'PROGRAMME_NOT_FOUND', 'Programme not found');
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Programme status error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not change the programme');
    }
});

// DELETE /api/admin/programmes/:id?semester_id=: only when nothing uses it; its unused courses of
// that semester go with it
router.delete('/admin/programmes/:id', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const semesterId = positiveInt(req.query.semester_id);
    try {
        const result = await inTransaction(async (client) => {
            const programme = (await client.query('SELECT id FROM programmes WHERE id = $1 FOR UPDATE', [req.ids.id])).rows[0];
            if (!programme) return { error: [404, 'PROGRAMME_NOT_FOUND', 'Programme not found'] };
            const blockedBy = await programmeBlockers(client, programme.id, semesterId);
            const courses = (await client.query(
                `SELECT c.id, ${courseUsageSql} FROM courses c LEFT JOIN semester_bounds sb ON sb.id = c.semester_id WHERE c.programme_id = $1`,
                [programme.id]
            )).rows;
            if (courses.some((c) => courseBlockers(c).length > 0)) blockedBy.push('COURSES_IN_USE');
            if (blockedBy.length > 0) return { error: [409, 'DELETE_IN_USE', 'This programme is in use, so it cannot be deleted'], blockedBy };
            await client.query('DELETE FROM courses WHERE programme_id = $1', [programme.id]);
            await client.query('DELETE FROM programmes WHERE id = $1', [programme.id]);
            return {};
        });
        if (result.error) return res.status(result.error[0]).json({ error: result.error[2], code: result.error[1], blockedBy: result.blockedBy });
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Delete programme error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not delete the programme');
    }
});

// PUT /api/admin/courses/:id/status { status: active | hidden }: not in a closed semester
router.put('/admin/courses/:id/status', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const status = readStatus(req, res);
    if (!status) return undefined;
    try {
        const course = (await pool.query(
            `SELECT c.id, COALESCE(sb.ends_at <= now() OR sb.status = 'closed', false) AS semester_closed
             FROM courses c LEFT JOIN semester_bounds sb ON sb.id = c.semester_id WHERE c.id = $1`, [req.ids.id]
        )).rows[0];
        if (!course) return sendError(res, 404, 'COURSE_NOT_FOUND', 'Course not found');
        if (course.semester_closed) return sendError(res, 409, 'SEMESTER_CLOSED', 'A closed semester cannot be changed');
        await pool.query('UPDATE courses SET status = $2 WHERE id = $1', [req.ids.id, status]);
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Course status error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not change the course');
    }
});

// DELETE /api/admin/courses/:id: only when no application or draft names it and its semester is open
router.delete('/admin/courses/:id', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        const result = await inTransaction(async (client) => {
            const course = (await client.query(
                `SELECT c.id, ${courseUsageSql} FROM courses c LEFT JOIN semester_bounds sb ON sb.id = c.semester_id WHERE c.id = $1 FOR UPDATE OF c`,
                [req.ids.id]
            )).rows[0];
            if (!course) return { error: [404, 'COURSE_NOT_FOUND', 'Course not found'] };
            const blockedBy = courseBlockers(course);
            if (blockedBy.length > 0) return { error: [409, 'DELETE_IN_USE', 'This course is in use, so it cannot be deleted'], blockedBy };
            await client.query('DELETE FROM courses WHERE id = $1', [course.id]);
            return {};
        });
        if (result.error) return res.status(result.error[0]).json({ error: result.error[2], code: result.error[1], blockedBy: result.blockedBy });
        return res.json({ success: true });
    } catch (err) {
        console.error('❌ Delete course error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not delete the course');
    }
});

module.exports = router;
