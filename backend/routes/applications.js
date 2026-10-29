const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const notifyStudent = require('../utils/notifyStudent');
const { findFilesNotOwnedBy, splitFileList } = require('../utils/fileOwner');
const sendError = require('../utils/sendError');
const { sendValidationErrors } = sendError;
const { validateApplicationForm, filesWithPaths, syllabusReasons, syllabusNote, missingSyllabi } = require('../utils/applicationForm');


// The only statuses the app understands (badges, reviewer tabs, emails, term book)
const VALID_STATUSES = ['pending', 'needs_info', 'approved', 'rejected'];

const checkSubmissionsOpen = async () => {
    const result = await pool.query('SELECT is_submissions_open FROM system_settings LIMIT 1');
    return result.rows.length > 0 ? result.rows[0].is_submissions_open : false;
};

// Submit an application. The student, their programme and the target courses' details all
// come from the database; anything else in the request (student_id, programme_id,
// pte_course_names, system_note) is ignored. Institutions and fulfilled courses are stored only as
// rebuilt from checked fields (utils/applicationForm.js).
router.post('/applications', verifyToken, requireRole('student'), async (req, res) => {
    const { student_note } = req.body;

    const student_id = req.user.id;

    try {
        const isOpen = await checkSubmissionsOpen();
        if (!isOpen) {
            return sendError(res, 403, 'SUBMISSIONS_CLOSED', 'Submissions are currently closed');
        }

        // 1. Every field rule at once (400 with all problems and their field paths)
        const form = validateApplicationForm(req.body);
        if (form.errors.length > 0) return sendValidationErrors(res, form.errors);
        const targetIds = form.targetCourseIds;

        // 2. Every target course must belong to the student's own programme (read from the database).
        // A course of another programme and an id that doesn't exist get the same answer.
        // The same query gives the snapshot that is saved, so it is exactly what was checked.
        const programmeId = (await pool.query('SELECT programme_id FROM users WHERE id = $1', [student_id])).rows[0]?.programme_id;
        const found = await pool.query(
            'SELECT id, course_code, course_name, credits FROM courses WHERE id = ANY($1) AND programme_id = $2',
            [targetIds, programmeId]
        );
        if (!programmeId || found.rows.length !== targetIds.length) {
            return sendError(res, 400, 'COURSE_NOT_IN_PROGRAMME', 'A chosen course is not part of your programme', { field: 'target_course_ids' });
        }
        // Snapshot in the order the student chose them (kept as is if courses are re-imported later)
        const byId = new Map(found.rows.map((c) => [c.id, c]));
        const targetCourses = targetIds.map((id) => {
            const c = byId.get(id);
            return { course_id: c.id, course_code: c.course_code, course_name: c.course_name, credits: c.credits };
        });
        // Legacy text list, still read by the reviewer and admin screens and the term book.
        // To be dropped after the reviewer and admin rounds (use target_courses instead).
        const pteCourseNames = targetCourses.map((c) => `${c.course_code} (${c.course_name})`).join(' + ');

        // 3. Syllabus rule: when it applies, every fulfilled course needs its syllabus.
        //    The reasons are stored as codes (for translation later) and as an English note.
        const targetCredits = targetCourses.reduce((sum, c) => sum + Number(c.credits), 0);
        const reasons = syllabusReasons(form.fulfilledCourses, targetCredits);
        const missing = reasons.length > 0 ? missingSyllabi(form.fulfilledCourses) : [];
        if (missing.length > 0) return sendValidationErrors(res, missing);

        // 4. Transcripts, syllabi and grading files must be the student's own uploads. A file of someone else
        //    and a file that doesn't exist get the identical answer (no way to probe file names).
        const files = filesWithPaths(form.institutions, form.fulfilledCourses);
        const notOwned = new Set(await findFilesNotOwnedBy([...new Set(files.map((f) => f.file))], student_id));
        const fileErrors = files.filter((f) => notOwned.has(f.file)).map(({ field }) => (
            { field, code: 'FILES_NOT_OWNED', message: 'You can only attach files you uploaded yourself' }
        ));
        if (fileErrors.length > 0) return sendValidationErrors(res, fileErrors, 403);

        await pool.query(
            `INSERT INTO applications 
            (student_id, programme_id, institutions, fulfilled_courses_json, target_courses, pte_course_names, system_note, syllabus_reasons, student_note, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
            [student_id, programmeId, JSON.stringify(form.institutions), JSON.stringify(form.fulfilledCourses), JSON.stringify(targetCourses), pteCourseNames, syllabusNote(reasons), reasons, student_note]
        );
        res.json({ success: true });

        // Respond first, then email in the background (never blocks or fails the request)
        notifyStudent(student_id, 'submitted');
    } catch (err) {
        console.error('❌ Submission error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Submission failed');
    }
});

// The logged-in student's own applications: the id comes from the token, never from the URL
router.get('/applications/mine', verifyToken, requireRole('student'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM applications WHERE student_id=$1 ORDER BY created_at DESC', [req.user.id]);
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error('❌ Fetch my apps error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// One student's applications, for reviewers and the superadmin (e.g. the impersonation view)
router.get('/applications/student/:id', verifyToken, requireRole('reviewer', 'superadmin'), async (req, res) => {
    const requestedId = parseInt(req.params.id, 10);

    try {
        const result = await pool.query('SELECT * FROM applications WHERE student_id=$1 ORDER BY created_at DESC', [requestedId]);
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error('❌ Fetch student apps error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});


router.get('/applications', verifyToken, requireRole('reviewer', 'superadmin'), async (req, res) => {

    try {
        const result = await pool.query(
            `SELECT a.*, u.name as student_name FROM applications a JOIN users u ON a.student_id=u.id ORDER BY a.created_at DESC`
        );
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error('❌ Fetch all apps error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

router.put('/applications/:id/status', verifyToken, requireRole('reviewer', 'superadmin'), async (req, res) => {
    const { status, note } = req.body;

    if (!VALID_STATUSES.includes(status)) {
        return sendError(res, 400, 'INVALID_STATUS', 'This status is not valid');
    }

    try {
        // Read the current status first, so we only email when it actually changes
        const current = await pool.query('SELECT status FROM applications WHERE id=$1', [req.params.id]);
        if (current.rows.length === 0) {
            return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        }
        const previousStatus = current.rows[0].status;

        // Record who made the decision and when (the logged-in reviewer or superadmin)
        const updated = await pool.query(
            'UPDATE applications SET status=$1, reviewer_note=$2, reviewed_by=$3, reviewed_at=NOW() WHERE id=$4 RETURNING student_id, reviewer_note',
            [status, note, req.user.id, req.params.id]
        );
        res.json({ success: true });

        // Respond first, then email in the background (never blocks or fails the request)
        if (status !== previousStatus) {
            const { student_id, reviewer_note } = updated.rows[0];
            const type = status === 'needs_info' ? 'needsInfo' : 'statusUpdate';
            notifyStudent(student_id, type, { status, note: reviewer_note });
        }
    } catch (err) {
       console.error("❌ Status update error:", err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Update failed');
    }
});

// Resubmit adds a note and evidence files only. Target courses and programme can't be changed
// here: any target_course_ids, pte_course_names or programme_id in the request is ignored.
router.put('/applications/:id/resubmit', verifyToken, requireRole('student'), async (req, res) => {
    const { id } = req.params;
    const { student_resubmit_note, new_files } = req.body;

    try {
        const ownerCheck = await pool.query('SELECT student_id, status, supplemental_files FROM applications WHERE id = $1', [id]);
        if (ownerCheck.rows.length === 0) {
            return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        }
        if (ownerCheck.rows[0].student_id !== req.user.id) {
            return sendError(res, 403, 'NOT_OWNER', 'You can only resubmit your own applications');
        }
        // Only an application the reviewer sent back for more information can be resubmitted
        if (ownerCheck.rows[0].status !== 'needs_info') {
            return sendError(res, 409, 'NOT_WAITING_FOR_INFO', 'This application is not waiting for more information');
        }

        const isOpen = await checkSubmissionsOpen();
        if (!isOpen) {
            return sendError(res, 403, 'SUBMISSIONS_CLOSED', 'Submissions are currently closed');
        }

        // Only the student's own uploads may be added as evidence
        const newFiles = splitFileList(new_files);
        if ((await findFilesNotOwnedBy(newFiles, req.user.id)).length > 0) {
            return sendError(res, 403, 'FILES_NOT_OWNED', 'You can only attach files you uploaded yourself');
        }

        // Append to the existing list without empty entries (no stray commas)
        const updatedFiles = [...splitFileList(ownerCheck.rows[0].supplemental_files), ...newFiles].join(',');

        await pool.query(
            "UPDATE applications SET status = 'pending', student_resubmit_note = $1, supplemental_files = $2 WHERE id = $3", 
            [student_resubmit_note, updatedFiles, id]
        );
        res.json({ success: true });

        // Respond first, then email in the background (never blocks or fails the request)
        notifyStudent(req.user.id, 'resubmitted');
    } catch (err) {
        console.error('❌ Resubmit error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Resubmit failed');
    }
});

module.exports = router;