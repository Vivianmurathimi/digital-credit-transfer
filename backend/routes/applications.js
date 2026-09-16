const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');


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

        await pool.query(
            `INSERT INTO applications 
            (student_id, fulfilled_courses_json, pte_course_names, system_note, student_note, status) 
            VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [student_id, JSON.stringify(fulfilled_courses_json), pte_course_names, system_note, student_note]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Submission error:', err.message);
        res.status(500).json({ error: 'Submission failed' });
    }
});

router.get('/applications/student/:id', verifyToken, async (req, res) => {
    const requestedId = parseInt(req.params.id, 10);

    if (req.user.role === 'student' && req.user.id !== requestedId) {
        return res.status(403).json({ error: 'You can only view your own applications' });
    }

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
    try {
        await pool.query('UPDATE applications SET status=$1, reviewer_note=$2 WHERE id=$3', [req.body.status, req.body.note, req.params.id]);
        res.json({ success: true });
    } catch (err) {
       console.error("❌ Status update error:", err.message);
        res.status(500).json({ error: "Update failed" });
    }
});

router.put('/applications/:id/resubmit', verifyToken, requireRole('student'), async (req, res) => {
    const { id } = req.params;
    const { student_resubmit_note, new_files } = req.body;

    try {
        const ownerCheck = await pool.query('SELECT student_id, supplemental_files FROM applications WHERE id = $1', [id]);
        if (ownerCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }
        if (ownerCheck.rows[0].student_id !== req.user.id) {
            return res.status(403).json({ error: 'You can only resubmit your own applications' });
        }

        const isOpen = await checkSubmissionsOpen();
        if (!isOpen) {
            return res.status(403).json({ success: false, error: 'Submissions are currently closed' });
        }

        let updatedFiles = new_files;
        if (ownerCheck.rows[0].supplemental_files) {
            updatedFiles = ownerCheck.rows[0].supplemental_files + ',' + new_files;
        }

        await pool.query(
            "UPDATE applications SET status = 'pending', student_resubmit_note = $1, supplemental_files = $2 WHERE id = $3", 
            [student_resubmit_note, updatedFiles, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Resubmit error:', err.message);
        res.status(500).json({ error: 'Resubmit failed' });
    }
});

module.exports = router;