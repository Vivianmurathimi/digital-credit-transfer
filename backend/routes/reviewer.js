const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');
const { resolveReviewerView } = require('../utils/reviewers');
const { getFileOwner, splitFileList } = require('../utils/fileOwner');
const { semesterEndedSql } = require('../utils/semesters');

// The reviewer dashboard (reviewer Groups 3 and 4). Always the logged-in reviewer's view; the
// superadmin sees it by acting as the reviewer (admin round Group 1).
// Every query is limited to that reviewer's programme.

// The semester running now (from its first application day to its last day), like the student side
// The current semester is the active one (admin round Group 4)
const CURRENT_SEMESTER = "SELECT id, name FROM semester_bounds WHERE status = 'active' LIMIT 1";

/**
 * What the dashboard lists, in one query:
 * - pending and needs_info: from any semester (the semester-end job closes open applications
 *   whose semester has ended, jobs/applicationJobs.js closeEndedSemesters)
 * - approved and rejected (also by the system): only in the current semester
 * - withdrawn: never
 * last_action_at: the submission or the student's latest reply. waiting_days: Budapest calendar days since then.
 * other_count: the student's other listed applications in the same semester (so only what this reviewer sees).
 * fulfilled_course_names: only for the search; the details come from GET /reviewer/applications/:id.
 */
// The current view: open applications of any semester, decided ones of the current semester
const CURRENT_VIEW = `a.programme_id = $1
          AND (a.status IN ('pending', 'needs_info')
               OR (a.status IN ('approved', 'rejected') AND a.semester_id = (SELECT id FROM cur)))`;
// A past semester (reviewer group L3, read-only): every application of it except withdrawn ones
const PAST_VIEW = "a.programme_id = $1 AND a.semester_id = $2 AND a.status <> 'withdrawn'";

const listQuery = (view) => `
    WITH cur AS (${CURRENT_SEMESTER}),
    visible AS (
        SELECT a.* FROM applications a
        WHERE ${view}
    ),
    listed AS (
        SELECT v.*, COALESCE(r.resubmit_count, 0) AS resubmit_count,
               COALESCE(r.last_replied_at, v.created_at AT TIME ZONE 'UTC') AS last_action_at
        FROM visible v
        LEFT JOIN LATERAL (
            SELECT count(*)::int AS resubmit_count, max(e.created_at) AS last_replied_at
            FROM application_events e WHERE e.application_id = v.id AND e.kind = 'replied'
        ) r ON true
    )
    SELECT l.id, l.status, l.student_id, l.semester_id, u.name AS student_name, u.neptun_code,
           l.target_course_code, l.target_courses,
           ARRAY(SELECT c->>'course_name' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.fulfilled_courses_json) = 'array' THEN l.fulfilled_courses_json ELSE '[]'::jsonb END) c) AS fulfilled_course_names,
           l.created_at AT TIME ZONE 'UTC' AS submitted_at, l.last_action_at, l.resubmit_count,
           ((now() AT TIME ZONE 'Europe/Budapest')::date - (l.last_action_at AT TIME ZONE 'Europe/Budapest')::date) AS waiting_days,
           l.info_deadline AS respond_by,
           l.decided_by_role, decider.name AS decided_by_name, l.decided_at, l.final_grade,
           (SELECT count(*)::int FROM listed o
            WHERE o.student_id = l.student_id AND o.id <> l.id AND o.semester_id IS NOT DISTINCT FROM l.semester_id) AS other_count
    FROM listed l
    JOIN users u ON u.id = l.student_id
    LEFT JOIN users decider ON decider.id = l.decided_by
    ORDER BY l.last_action_at, l.id`;
const LIST_QUERY = listQuery(CURRENT_VIEW);
const PAST_LIST_QUERY = listQuery(PAST_VIEW);

// Ended semesters with at least one (not withdrawn) application of the programme, newest first
const PAST_SEMESTERS_QUERY = `
    SELECT s.id, s.name, to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on, count(a.id)::int AS applications
    FROM semester_bounds s
    JOIN applications a ON a.semester_id = s.id AND a.programme_id = $1 AND a.status <> 'withdrawn'
    WHERE s.ends_at <= now() OR s.status = 'closed'
    GROUP BY s.id, s.name, s.ends_on
    ORDER BY s.ends_on DESC`;

// ?semester=<id>: a whole number; anything else is treated like a semester that doesn't exist
const readSemesterId = (value) => {
    if (value === undefined) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
};

// GET /api/reviewer/semesters: the past semesters the reviewer can look at (reviewer group L3)
router.get('/reviewer/semesters', verifyToken, requireRole('reviewer'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const view = await resolveReviewerView(pool, req);
        const current = (await pool.query(CURRENT_SEMESTER)).rows[0] || null;
        const { rows } = await pool.query(PAST_SEMESTERS_QUERY, [view.reviewer.programme_id]);
        res.json({ success: true, current, past: rows });
    } catch (err) {
        console.error('❌ Reviewer semesters error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// GET /api/reviewer/applications[?semester=<id>]: the header and the list.
// With semester: that past semester's applications of the reviewer's programme, read-only
// (read_only: true). A semester that doesn't exist or hasn't ended: 404 SEMESTER_NOT_FOUND.
router.get('/reviewer/applications', verifyToken, requireRole('reviewer'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const view = await resolveReviewerView(pool, req);
        const { reviewer } = view;

        const programme = (await pool.query('SELECT code, name_en, name_hu, name_de FROM programmes WHERE id = $1', [reviewer.programme_id])).rows[0];
        const semesterId = readSemesterId(req.query.semester);
        if (semesterId !== null) {
            const past = (await pool.query("SELECT id, name FROM semester_bounds WHERE id = $1 AND (ends_at <= now() OR status = 'closed')", [semesterId])).rows[0];
            if (!past) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'No past semester with this id');
            const { rows } = await pool.query(PAST_LIST_QUERY, [reviewer.programme_id, past.id]);
            return res.json({ success: true, reviewer: { id: reviewer.id, name: reviewer.name, programme }, semester: past, read_only: true, applications: rows });
        }

        const semester = (await pool.query(CURRENT_SEMESTER)).rows[0] || null;
        const { rows } = await pool.query(LIST_QUERY, [reviewer.programme_id]);

        res.json({
            success: true,
            reviewer: { id: reviewer.id, name: reviewer.name, programme },
            semester,
            read_only: false,
            applications: rows,
        });
    } catch (err) {
        console.error('❌ Reviewer list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// fulfilled_courses_json and institutions are JSONB arrays; anything else counts as empty
const asList = (value) => (Array.isArray(value) ? value : []);

/**
 * GET /api/reviewer/applications/:id: one application's details (reviewer Group 4),
 * only from the reviewer's own programme (any other id: 404, like one that doesn't exist).
 * Withdrawn applications aren't listed, so they have no details either.
 * files: for every file the application names, the name the student gave it and whether it still
 * exists, so the page can say "missing" instead of opening an empty tab.
 * events (reviewer Group 5): the whole history from application_events, oldest first, with
 * note_type from the application_notes view (student, resubmit, reviewer, system; null without
 * a note) and the actor's name. The conversation and the history table are both built from it.
 */
router.get('/reviewer/applications/:id', verifyToken, requireRole('reviewer'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
    try {
        const view = await resolveReviewerView(pool, req);

        const found = (await pool.query(
            `SELECT a.id, a.status, a.student_id, a.target_course_code, a.target_courses, a.fulfilled_courses_json, a.institutions,
                    a.supplemental_files, a.final_grade, a.decided_by_role, decider.name AS decided_by_name, a.decided_at,
                    a.decision_rationale, a.info_deadline AS respond_by,
                    ${semesterEndedSql('a')} AS read_only, sem.id AS semester_id, sem.name AS semester_name,
                    u.name AS student_name, u.neptun_code, p.code AS programme_code, p.name_en, p.name_hu, p.name_de
             FROM applications a
             JOIN users u ON u.id = a.student_id
             JOIN programmes p ON p.id = a.programme_id
             LEFT JOIN semesters sem ON sem.id = a.semester_id
             LEFT JOIN users decider ON decider.id = a.decided_by
             WHERE a.id = $1 AND a.programme_id = $2 AND a.status <> 'withdrawn'`,
            [id, view.reviewer.programme_id]
        )).rows[0];
        if (!found) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');

        const courses = asList(found.fulfilled_courses_json);
        const institutions = asList(found.institutions);
        // The history. actor_id stays on the server: only the name is sent (no email addresses), and
        // only for students and reviewers; an admin is shown as "Admin", the system as "System"
        const events = (await pool.query(
            `SELECT e.id, e.kind, e.actor_role, CASE WHEN e.actor_role IN ('student', 'reviewer') THEN u.name END AS actor_name,
                    e.status, e.note, e.reason_code,
                    -- an automatic rejection has no text, only its reason code: still a "system" note
                    COALESCE(n.note_type, CASE WHEN e.kind = 'auto_rejected' AND e.reason_code IS NOT NULL THEN 'system' END) AS note_type,
                    e.files, e.backfilled, e.created_at
             FROM application_events e
             LEFT JOIN application_notes n ON n.id = e.id
             LEFT JOIN users u ON u.id = e.actor_id
             WHERE e.application_id = $1
             ORDER BY e.created_at, e.id`,
            [id]
        )).rows;
        // Reply files sit with their reply. Files only in the old comma list (from before the history
        // kept them; migration 007 copied the latest ones over) are listed on their own.
        const eventFiles = events.flatMap((e) => e.files);
        const extraFiles = splitFileList(found.supplemental_files).filter((f) => !eventFiles.includes(f));

        const names = new Set([
            ...courses.flatMap((c) => [c.file, c.syllabus_file]),
            ...institutions.map((i) => i.grading_file),
            ...eventFiles,
            ...extraFiles,
        ].filter((f) => typeof f === 'string' && f));
        const files = {};
        for (const name of names) {
            const { exists, originalName } = await getFileOwner(name);
            files[name] = { exists, original_name: exists ? originalName || null : null };
        }

        const [target] = asList(found.target_courses);
        res.json({
            success: true,
            application: {
                id: found.id,
                status: found.status,
                student: {
                    id: found.student_id, name: found.student_name, neptun_code: found.neptun_code,
                    programme: { code: found.programme_code, name_en: found.name_en, name_hu: found.name_hu, name_de: found.name_de },
                },
                target_course: {
                    course_code: target?.course_code || found.target_course_code || '',
                    course_name: target?.course_name || '',
                    credits: target?.credits ?? null,
                },
                fulfilled_courses: courses,
                institutions,
                extra_files: extraFiles,
                files,
                events,
                // The decision (reviewer Group 6); the decider's name only for a reviewer
                decision: {
                    final_grade: found.final_grade,
                    decided_by_role: found.decided_by_role,
                    decided_by_name: found.decided_by_role === 'reviewer' ? found.decided_by_name : null,
                    decided_at: found.decided_at,
                    rationale: found.decision_rationale,
                    // An automatic rejection's reason (reviewer Group 7): a code, translated by the screen
                    reason_code: found.decided_by_role === 'system'
                        ? [...events].reverse().find((e) => e.kind === 'auto_rejected')?.reason_code || null
                        : null,
                },
                respond_by: found.respond_by,
                // Its semester has ended (reviewer group L3): shown read-only, every change is refused
                semester: found.semester_id ? { id: found.semester_id, name: found.semester_name } : null,
                read_only: found.read_only,
            },
        });
    } catch (err) {
        console.error('❌ Reviewer application details error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

module.exports = router;
