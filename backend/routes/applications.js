const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const notifyStudent = require('../utils/notifyStudent');
const { findFilesNotOwnedBy, splitFileList } = require('../utils/fileOwner');
const sendError = require('../utils/sendError');


// The only statuses the app understands (badges, reviewer tabs, emails, term book)
const VALID_STATUSES = ['pending', 'needs_info', 'approved', 'rejected'];

// At most this many target courses per application (after removing duplicates)
const MAX_TARGET_COURSES = 10;

// A non-empty list of positive whole numbers, duplicates removed; null if the input is not that
const readTargetCourseIds = (value) => {
    if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id) && id > 0)) return null;
    const ids = [...new Set(value)];
    return ids.length >= 1 && ids.length <= MAX_TARGET_COURSES ? ids : null;
};

const checkSubmissionsOpen = async () => {
    const result = await pool.query('SELECT is_submissions_open FROM system_settings LIMIT 1');
    return result.rows.length > 0 ? result.rows[0].is_submissions_open : false;
};

// Submit an application. The student, their programme and the target courses' details all
// come from the database; anything else in the request (student_id, programme_id,
// pte_course_names) is ignored.
router.post('/applications', verifyToken, requireRole('student'), async (req, res) => {
    const { 
        fulfilled_courses_json, 
        target_course_ids,
        system_note,
        student_note
    } = req.body;

    const student_id = req.user.id;

    try {
        const isOpen = await checkSubmissionsOpen();
        if (!isOpen) {
            return sendError(res, 403, 'SUBMISSIONS_CLOSED', 'Submissions are currently closed');
        }

        const targetIds = readTargetCourseIds(target_course_ids);
        if (!targetIds) {
            return sendError(res, 400, 'INVALID_TARGET_COURSES', `Choose between 1 and ${MAX_TARGET_COURSES} target courses`, { field: 'target_course_ids' });
        }

        // Every target course must belong to the student's own programme (read from the database).
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

        // Only the student's own uploads may be attached as evidence
        const courses = Array.isArray(fulfilled_courses_json) ? fulfilled_courses_json : [];
        const attachedFiles = courses.map((course) => course && course.file).filter(Boolean);
        if ((await findFilesNotOwnedBy(attachedFiles, student_id)).length > 0) {
            return sendError(res, 403, 'FILES_NOT_OWNED', 'You can only attach files you uploaded yourself');
        }

        await pool.query(
            `INSERT INTO applications 
            (student_id, programme_id, fulfilled_courses_json, target_courses, pte_course_names, system_note, student_note, status) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
            [student_id, programmeId, JSON.stringify(fulfilled_courses_json), JSON.stringify(targetCourses), pteCourseNames, system_note, student_note]
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