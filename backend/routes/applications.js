const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const notifyStudent = require('../utils/notifyStudent');
const { findFilesNotOwnedBy, splitFileList } = require('../utils/fileOwner');


const checkSubmissionsOpen = async () => {
    const result = await pool.query('SELECT is_submissions_open FROM system_settings LIMIT 1');
    return result.rows.length > 0 ? result.rows[0].is_submissions_open : false;
};

router.post('/applications', verifyToken, requireRole('student'), async (req, res) => {
    const { 
        fulfilled_courses_json, 
        pte_course_names, 
        system_note,
        student_note
    } = req.body;

    const student_id = req.user.id;

    try {
        const isOpen = await checkSubmissionsOpen();
        if (!isOpen) {
            return res.status(403).json({ success: false, error: 'Submissions are currently closed' });
        }

        // Only the student's own uploads may be attached as evidence
        const courses = Array.isArray(fulfilled_courses_json) ? fulfilled_courses_json : [];
        const attachedFiles = courses.map((course) => course && course.file).filter(Boolean);
        if ((await findFilesNotOwnedBy(attachedFiles, student_id)).length > 0) {
            return res.status(403).json({ error: 'You can only attach files you uploaded yourself' });
        }

        await pool.query(
            `INSERT INTO applications 
            (student_id, fulfilled_courses_json, pte_course_names, system_note, student_note, status) 
            VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [student_id, JSON.stringify(fulfilled_courses_json), pte_course_names, system_note, student_note]
        );
        res.json({ success: true });

        // Respond first, then email in the background (never blocks or fails the request)
        notifyStudent(student_id, 'submitted');
    } catch (err) {
        console.error('❌ Submission error:', err.message);
        res.status(500).json({ error: 'Submission failed' });
    }
});

// The logged-in student's own applications: the id comes from the token, never from the URL
router.get('/applications/mine', verifyToken, requireRole('student'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM applications WHERE student_id=$1 ORDER BY created_at DESC', [req.user.id]);
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error('❌ Fetch my apps error:', err.message);
        res.status(500).json({ error: 'Fetch failed' });
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
        res.status(500).json({ error: 'Fetch failed' });
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
        res.status(500).json({ error: 'Fetch failed' });
    }
});

router.put('/applications/:id/status', verifyToken, requireRole('reviewer', 'superadmin'), async (req, res) => {
    const { status, note } = req.body;

    try {
        // Read the current status first, so we only email when it actually changes
        const current = await pool.query('SELECT status FROM applications WHERE id=$1', [req.params.id]);
        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
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
        res.status(500).json({ error: "Update failed" });
    }
});

router.put('/applications/:id/resubmit', verifyToken, requireRole('student'), async (req, res) => {
    const { id } = req.params;
    const { student_resubmit_note, new_files } = req.body;

    try {
        const ownerCheck = await pool.query('SELECT student_id, status, supplemental_files FROM applications WHERE id = $1', [id]);
        if (ownerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }
        if (ownerCheck.rows[0].student_id !== req.user.id) {
            return res.status(403).json({ error: 'You can only resubmit your own applications' });
        }
        // Only an application the reviewer sent back for more information can be resubmitted
        if (ownerCheck.rows[0].status !== 'needs_info') {
            return res.status(409).json({ error: 'This application is not waiting for more information' });
        }

        const isOpen = await checkSubmissionsOpen();
        if (!isOpen) {
            return res.status(403).json({ success: false, error: 'Submissions are currently closed' });
        }

        // Only the student's own uploads may be added as evidence
        const newFiles = splitFileList(new_files);
        if ((await findFilesNotOwnedBy(newFiles, req.user.id)).length > 0) {
            return res.status(403).json({ error: 'You can only attach files you uploaded yourself' });
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
        res.status(500).json({ error: 'Resubmit failed' });
    }
});

module.exports = router;