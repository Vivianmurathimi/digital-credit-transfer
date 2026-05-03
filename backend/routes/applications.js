const express = require('express');
const router = express.Router();
const pool = require('../db');

const checkSubmissionsOpen = async () => {
    const result = await pool.query('SELECT is_submissions_open FROM system_settings LIMIT 1');
    return result.rows.length > 0 ? result.rows[0].is_submissions_open : false;
};

router.post('/applications', async (req, res) => {
    const { 
        student_id, 
        fulfilled_courses_json, 
        pte_course_names, 
        system_note,
        student_note
    } = req.body;

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

router.get('/applications/student/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM applications WHERE student_id=$1 ORDER BY created_at DESC', [req.params.id]);
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error('❌ Fetch student apps error:', err.message);
        res.status(500).json({ error: 'Fetch failed' });
    }
});

router.get('/applications', async (req, res) => {
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

router.put('/applications/:id/status', async (req, res) => {
    try {
        await pool.query('UPDATE applications SET status=$1, reviewer_note=$2 WHERE id=$3', [req.body.status, req.body.note, req.params.id]);
        res.json({ success: true });
    } catch (err) {
       console.error("❌ Status update error:", err.message);
        res.status(500).json({ error: "Update failed" });
    }
});

router.put('/applications/:id/resubmit', async (req, res) => {
    const { id } = req.params;
    const { student_resubmit_note, new_files } = req.body;

    try {
        const isOpen = await checkSubmissionsOpen();
        if (!isOpen) {
            return res.status(403).json({ success: false, error: 'Submissions are currently closed' });
        }

        const current = await pool.query('SELECT supplemental_files FROM applications WHERE id = $1', [id]);
        let updatedFiles = new_files;
        if (current.rows.length > 0 && current.rows[0].supplemental_files) {
            updatedFiles = current.rows[0].supplemental_files + ',' + new_files;
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