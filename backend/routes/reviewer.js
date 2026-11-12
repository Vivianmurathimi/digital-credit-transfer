const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');
const { resolveReviewerView } = require('../utils/reviewers');
const { semesterEndedSql } = require('../utils/semesters');
const { loadApplicationDetails } = require('../utils/applicationDetails');

// The reviewer dashboard (reviewer Groups 3 and 4). Always the logged-in reviewer's view; the
// superadmin sees it by acting as the reviewer (admin round Group 1).
// Every query is limited to the programmes that reviewer can see now (utils/reviewers.js: the main
// reviewer, or an extra reviewer while allowed to assist).

// The semesters in progress (round 2 Group 1: several at once; the next one's application period
// may open while the previous one is still being reviewed), with their review deadlines
const IN_PROGRESS_SEMESTERS = `
    SELECT id, name, opens_at, closes_at, review_ends_at FROM semester_bounds WHERE status = 'active' ORDER BY opens_at`;

/**
 * What the dashboard lists, in one query:
 * - pending and needs_info: from any semester not closed yet (a semester closes only when nothing
 *   is undecided, utils/semesterClose.js)
 * - approved and rejected (also by the system): only in the semesters in progress
 * - $2: one semester in progress only (the semester filter), or null for all of them
 * - withdrawn: never
 * last_action_at: the submission or the student's latest reply. waiting_days: Budapest calendar days since then.
 * other_count: the student's other listed applications in the same semester (so only what this reviewer sees).
 * assigned_reviewer_id / assigned_name (round 2 Group 1): who the admin assigned it to; null = shared.
 * fulfilled_course_names: only for the search; the details come from GET /reviewer/applications/:id.
 */
// The current view: open applications of any semester, decided ones of the current semester
const CURRENT_VIEW = `a.programme_id = ANY($1::int[])
          AND (a.status IN ('pending', 'needs_info')
               OR (a.status IN ('approved', 'rejected') AND a.semester_id IN (SELECT id FROM cur)))
          AND ($2::int IS NULL OR a.semester_id = $2)`;
// A past semester (reviewer group L3, read-only): every application of it except withdrawn ones
const PAST_VIEW = "a.programme_id = ANY($1::int[]) AND a.semester_id = $2 AND a.status <> 'withdrawn'";

const listQuery = (view) => `
    WITH cur AS (SELECT id FROM semesters WHERE status = 'active'),
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
    SELECT l.id, l.status, l.student_id, l.semester_id, u.name AS student_name, u.neptun_code, lp.code AS programme_code,
           l.target_course_code, l.target_courses,
           ARRAY(SELECT c->>'course_name' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(l.fulfilled_courses_json) = 'array' THEN l.fulfilled_courses_json ELSE '[]'::jsonb END) c) AS fulfilled_course_names,
           l.created_at AT TIME ZONE 'UTC' AS submitted_at, l.last_action_at, l.resubmit_count,
           ((now() AT TIME ZONE 'Europe/Budapest')::date - (l.last_action_at AT TIME ZONE 'Europe/Budapest')::date) AS waiting_days,
           l.info_deadline AS respond_by,
           l.decided_by_role, decider.name AS decided_by_name, l.decided_at, l.final_grade,
           l.assigned_reviewer_id, assignee.name AS assigned_name,
           (SELECT count(*)::int FROM listed o
            WHERE o.student_id = l.student_id AND o.id <> l.id AND o.semester_id IS NOT DISTINCT FROM l.semester_id) AS other_count
    FROM listed l
    JOIN users u ON u.id = l.student_id
    JOIN programmes lp ON lp.id = l.programme_id
    LEFT JOIN users decider ON decider.id = l.decided_by
    LEFT JOIN users assignee ON assignee.id = l.assigned_reviewer_id
    ORDER BY l.last_action_at, l.id`;
const LIST_QUERY = listQuery(CURRENT_VIEW);
const PAST_LIST_QUERY = listQuery(PAST_VIEW);

// Ended semesters with at least one (not withdrawn) application of the reviewer's programmes, newest first
const PAST_SEMESTERS_QUERY = `
    SELECT s.id, s.name, to_char(s.ends_on, 'YYYY-MM-DD') AS ends_on, count(a.id)::int AS applications
    FROM semester_bounds s
    JOIN applications a ON a.semester_id = s.id AND a.programme_id = ANY($1::int[]) AND a.status <> 'withdrawn'
    WHERE s.status = 'closed'
    GROUP BY s.id, s.name, s.ends_on
    ORDER BY s.ends_on DESC`;

// ?semester=<id>: a whole number; anything else is treated like a semester that doesn't exist
const readSemesterId = (value) => {
    if (value === undefined) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
};

// GET /api/reviewer/semesters: the semesters in progress (with review deadlines) and the past
// ones the reviewer can look at (reviewer group L3). current: the first in progress (kept for older screens)
router.get('/reviewer/semesters', verifyToken, requireRole('reviewer'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const view = await resolveReviewerView(pool, req);
        const inProgress = (await pool.query(IN_PROGRESS_SEMESTERS)).rows;
        const { rows } = await pool.query(PAST_SEMESTERS_QUERY, [view.reviewer.programmeIds]);
        res.json({ success: true, current: inProgress[0] || null, inProgress, past: rows });
    } catch (err) {
        console.error('❌ Reviewer semesters error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// GET /api/reviewer/applications[?semester=<id>]: the header and the list.
// With a closed semester: its applications of the reviewer's programmes, read-only (read_only: true).
// With a semester in progress: the current view of that semester only. Any other id (unknown, in
// setup): 404 SEMESTER_NOT_FOUND. semesters: the semesters in progress, with their review deadlines.
router.get('/reviewer/applications', verifyToken, requireRole('reviewer'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const view = await resolveReviewerView(pool, req);
        const { reviewer } = view;

        // Every current link: the ones they see (main, or extra while assisting) and standby ones
        const programmes = reviewer.programmes.map(({ code, name_en, name_hu, name_de, role, can_assist, sees }) => ({ code, name_en, name_hu, name_de, role, can_assist, sees }));
        const header = { id: reviewer.id, name: reviewer.name, programmes };
        const semesterId = readSemesterId(req.query.semester);
        if (semesterId !== null) {
            const chosen = (await pool.query("SELECT id, name, status FROM semester_bounds WHERE id = $1 AND status IN ('closed', 'active')", [semesterId])).rows[0];
            if (!chosen) return sendError(res, 404, 'SEMESTER_NOT_FOUND', 'No such semester');
            if (chosen.status === 'closed') {
                const { rows } = await pool.query(PAST_LIST_QUERY, [reviewer.programmeIds, chosen.id]);
                return res.json({ success: true, reviewer: header, semester: { id: chosen.id, name: chosen.name }, read_only: true, applications: rows });
            }
        }

        const inProgress = (await pool.query(IN_PROGRESS_SEMESTERS)).rows;
        const only = semesterId !== null ? semesterId : null;
        const { rows } = await pool.query(LIST_QUERY, [reviewer.programmeIds, only]);

        res.json({
            success: true,
            reviewer: header,
            // the one semester shown (filter), or the first in progress; semesters: all in progress
            semester: (only ? inProgress.find((x) => x.id === only) : inProgress[0]) || null,
            semesters: inProgress,
            read_only: false,
            applications: rows,
        });
    } catch (err) {
        console.error('❌ Reviewer list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// The details themselves: utils/applicationDetails.js (shared with the admin's Past semesters)

/**
 * GET /api/reviewer/applications/:id: one application's details (reviewer Group 4),
 * only from the programmes the reviewer can see now (any other id: 404, like one that doesn't exist).
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

        const application = await loadApplicationDetails(pool, id, { programmeIds: view.reviewer.programmeIds });
        if (!application) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        res.json({ success: true, application });
    } catch (err) {
        console.error('❌ Reviewer application details error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

module.exports = router;
