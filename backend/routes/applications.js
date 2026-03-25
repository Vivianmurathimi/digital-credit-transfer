const express = require('express');
const router = express.Router();
const pool = require('../db');

router.post('/applications', async (req, res) => {
    const { student_id, previous_course, fulfilled_course_code, fulfilled_credits, fulfilled_grade, pte_course_names, syllabus_file, system_note } = req.body;
    try {
        await pool.query(
            `INSERT INTO applications (student_id, fulfilled_course, fulfilled_course_code, fulfilled_credits, fulfilled_grade, pte_course_names, syllabus_file, system_note, status) 
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
            [student_id, previous_course, fulfilled_course_code, fulfilled_credits, fulfilled_grade, pte_course_names, syllabus_file, system_note]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Submission failed" });
    }
});

router.get('/applications/student/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM applications WHERE student_id=$1 ORDER BY created_at DESC', [req.params.id]);
        res.json({ success: true, applications: result.rows });
    } catch {
        res.status(500).json({ error: "Fetch failed" });
    }
});

router.get('/applications', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT a.*, u.name as student_name FROM applications a JOIN users u ON a.student_id=u.id`
        );
        res.json({ success: true, applications: result.rows });
    } catch {
        res.status(500).json({ error: "Fetch failed" });
    }
});

router.put('/applications/:id/status', async (req, res) => {
    try {
        await pool.query('UPDATE applications SET status=$1, reviewer_note=$2 WHERE id=$3', [req.body.status, req.body.note, req.params.id]);
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: "Update failed" });
    }
});

module.exports = router;