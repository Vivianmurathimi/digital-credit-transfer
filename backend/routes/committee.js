const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireCommittee = require('../middleware/requireCommittee');
const requireRole = require('../middleware/requireRole');
const { requireIdParam, positiveInt } = require('../utils/validate');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const notifyStudent = require('../utils/notifyStudent');
const { committeeProgrammes, reviewerProgrammes } = require('../utils/reviewers');
const { loadApplicationDetails } = require('../utils/applicationDetails');
const { COMMITTEE_VISIBLE_SQL, checkCommitteeStep, takeCommitteeStep } = require('../utils/committee');
const { sendPdf, reviewerBook, applicationPdf } = require('../utils/pdfDownloads');
const { sendValidationErrors } = sendError;

// The committee (round 2 Group 2). After a reviewer (or an admin) decides, the programme's committee
// confirms it: keep or change (utils/committee.js). Access always comes from the person's CURRENT
// committee links, read from the database on every request (middleware/requireCommittee.js):
// a member sees only their committee programmes' applications that a reviewer or admin decided,
// awaiting the committee or handled by it; never pending, needs info, withdrawn, drafts or System
// decisions. The admin takes the step from admin Applications (PUT /admin/applications/:id/committee)
// or by acting as a member; either way it is recorded as the admin ("Admin, as committee").

// Who is acting: 'admin' for the superadmin (also while acting as a member), otherwise 'committee'
const committeeActorRole = (actor) => (actor.role === 'superadmin' ? 'admin' : 'committee');
const TABS = { waiting: "a.status = 'awaiting_committee'", handled: "a.committee_state IN ('kept', 'changed')" };

// GET /api/committee/me: the member's committee programmes, and whether they are also a reviewer
// (then the dashboard offers a Reviewer / Committee switch). No current programme: an empty list.
router.get('/committee/me', verifyToken, requireCommittee, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const me = (await pool.query('SELECT id, name FROM users WHERE id = $1', [req.user.id])).rows[0];
        const programmes = await committeeProgrammes(pool, req.user.id);
        const reviewerLinks = req.user.role === 'reviewer' ? await reviewerProgrammes(pool, req.user.id) : [];
        const semesters = (await pool.query(
            `SELECT DISTINCT s.id, s.name, s.status, s.applications_open_at FROM semesters s
             JOIN applications a ON a.semester_id = s.id
             WHERE a.programme_id = ANY($1::int[]) AND ${COMMITTEE_VISIBLE_SQL('a')}
             ORDER BY s.applications_open_at DESC`,
            [req.user.committeeProgrammeIds || []]
        )).rows.map(({ id, name, status }) => ({ id, name, status }));
        res.json({
            success: true,
            member: { id: me.id, name: me.name },
            programmes: programmes.map(({ code, name_en, name_hu, name_de }) => ({ code, name_en, name_hu, name_de })),
            semesters,
            alsoReviewer: req.user.role === 'reviewer',
            reviewerProgrammes: reviewerLinks.length,
        });
    } catch (err) {
        console.error('❌ Committee me error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

/**
 * GET /api/committee/applications?tab=waiting|handled[&programme=CODE][&semester=<id>]: the list.
 * waiting: awaiting the committee; handled: kept or changed. decided_by_me: the member made the
 * reviewer decision themselves (they can't confirm it). Who in the committee acted is not sent.
 */
router.get('/committee/applications', verifyToken, requireCommittee, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const tab = req.query.tab === undefined ? 'waiting' : req.query.tab;
    if (!TABS[tab]) return sendError(res, 400, 'INVALID_TAB', 'tab must be waiting or handled', { field: 'tab' });
    const semester = req.query.semester === undefined || req.query.semester === '' ? null : positiveInt(req.query.semester);
    if (req.query.semester !== undefined && req.query.semester !== '' && semester === null) return sendError(res, 400, 'INVALID_ID', 'semester must be a semester id', { field: 'semester' });
    try {
        const { rows } = await pool.query(
            `SELECT a.id, a.status, a.student_id, a.semester_id, s.name AS student_name, s.neptun_code, p.code AS programme_code,
                    a.target_course_code, a.target_courses,
                    ARRAY(SELECT c->>'course_name' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.fulfilled_courses_json) = 'array' THEN a.fulfilled_courses_json ELSE '[]'::jsonb END) c) AS fulfilled_course_names,
                    a.created_at AT TIME ZONE 'UTC' AS submitted_at,
                    a.reviewer_decision, a.reviewer_grade, a.decided_by_role, CASE WHEN a.decided_by_role = 'reviewer' THEN d.name END AS decided_by_name,
                    a.decided_at, a.decided_by = $2 AS decided_by_me,
                    a.committee_state, a.committee_at, a.committee_note, a.final_grade, sem.name AS semester_name,
                    COALESCE(a.decided_at, a.created_at AT TIME ZONE 'UTC') AS last_action_at
             FROM applications a
             JOIN users s ON s.id = a.student_id
             JOIN programmes p ON p.id = a.programme_id
             LEFT JOIN users d ON d.id = a.decided_by
             LEFT JOIN semesters sem ON sem.id = a.semester_id
             WHERE a.programme_id = ANY($1::int[]) AND ${COMMITTEE_VISIBLE_SQL('a')} AND ${TABS[tab]}
               AND ($3::text IS NULL OR p.code = $3) AND ($4::int IS NULL OR a.semester_id = $4)
             ORDER BY a.decided_at, a.id`,
            [req.user.committeeProgrammeIds || [], req.user.id, req.query.programme ? String(req.query.programme) : null, semester]
        );
        res.json({ success: true, tab, applications: rows });
    } catch (err) {
        console.error('❌ Committee list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// GET /api/committee/applications/:id: the details, read-only (the same view as the reviewer's).
// Anything the member may not see (another programme, pending, System...): 404.
router.get('/committee/applications/:id', verifyToken, requireCommittee, requireIdParam('id'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const application = await loadApplicationDetails(pool, req.ids.id, { programmeIds: req.user.committeeProgrammeIds || [], committeeOnly: true });
        if (!application) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        application.decided_by_me = (await pool.query('SELECT decided_by = $2 AS mine FROM applications WHERE id = $1', [req.ids.id, req.user.id])).rows[0].mine === true;
        res.json({ success: true, application, read_only: true });
    } catch (err) {
        console.error('❌ Committee details error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// The step itself, shared by the member's route and the admin's: then the student is emailed
const answerStep = async (req, res, programmeIds) => {
    const { errors, step } = checkCommitteeStep(req.body);
    if (errors) return sendValidationErrors(res, errors);
    try {
        const result = await inTransaction((client) => takeCommitteeStep(client, {
            applicationId: req.ids.id, step, actorId: req.actor.id, actorRole: committeeActorRole(req.actor), programmeIds,
        }));
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2], { field: result.error[3] });
        res.json({ success: true, status: result.done.status, final_grade: result.done.finalGrade });
        // The student learns the final result now (not at the reviewer's decision)
        notifyStudent(result.done.studentId, 'statusUpdate', { status: result.done.status, note: result.done.emailNote, finalGrade: result.done.finalGrade, byCommittee: true });
        return undefined;
    } catch (err) {
        console.error('❌ Committee step error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not save the committee decision');
    }
};

/**
 * PUT /api/committee/applications/:id/decision { action: keep|change, final_grade?, note? }:
 * the committee's step (rules: utils/committee.js). Only on the member's committee programmes.
 */
router.put('/committee/applications/:id/decision', verifyToken, requireCommittee, requireIdParam('id'),
    (req, res) => answerStep(req, res, req.user.committeeProgrammeIds || []));

// PUT /api/admin/applications/:id/committee: the admin takes the committee step directly (any
// programme), recorded as "Admin, as committee"; the same rules, the admin's own decision included
router.put('/admin/applications/:id/committee', verifyToken, requireRole('superadmin'), requireIdParam('id'),
    (req, res) => answerStep(req, res, null));

// ---------------------------------------------------------------------------------------------
// PDFs (Group 1 Part F) for members: their committee programmes only, checked here
// ---------------------------------------------------------------------------------------------

// GET /api/committee/applications/:id/pdf: one application the member can see
router.get('/committee/applications/:id/pdf', verifyToken, requireCommittee, requireIdParam('id'), async (req, res) => {
    try {
        const allowed = (await pool.query(
            `SELECT 1 FROM applications a WHERE a.id = $1 AND a.programme_id = ANY($2::int[]) AND ${COMMITTEE_VISIBLE_SQL('a')}`,
            [req.ids.id, req.user.committeeProgrammeIds || []]
        )).rows.length > 0;
        if (!allowed) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        const pdf = await applicationPdf(req.ids.id);
        if (!pdf) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        return sendPdf(res, pdf.fileName, pdf.buffer);
    } catch (err) {
        console.error('❌ Committee application PDF error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not make the PDF');
    }
});

// GET /api/committee/book.pdf?semester=<id>: the book of the member's committee programmes for a
// semester in progress (interim) or a closed one
router.get('/committee/book.pdf', verifyToken, requireCommittee, async (req, res) => {
    try {
        const programmes = await committeeProgrammes(pool, req.user.id);
        if (programmes.length === 0) return sendError(res, 404, 'NO_PROGRAMME', 'You are on no committee right now');
        const id = positiveInt(req.query.semester);
        const semester = id ? (await pool.query("SELECT id, name FROM semesters WHERE id = $1 AND status IN ('active', 'closed')", [id])).rows[0] : null;
        if (!semester) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'No such semester');
        const { buffer, fileName } = await reviewerBook(semester, programmes);
        return sendPdf(res, fileName, buffer);
    } catch (err) {
        console.error('❌ Committee book error:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not make the PDF');
    }
});

module.exports = router;
