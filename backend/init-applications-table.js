const express = require('express');
const router = express.Router();
const pool = require('./db'); 

// 1. Submit a New Application (Includes Phase 1 JSON & Phase 2 Cover Letter)
router.post('/applications', async (req, res) => {
    const { 
        student_id, 
        fulfilled_courses_json, 
        pte_course_names, 
        system_note,
        student_note 
    } = req.body;
    
    try {
        await pool.query(
            `INSERT INTO applications 
            (student_id, fulfilled_courses_json, pte_course_names, system_note, student_note, status) 
            VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [student_id, JSON.stringify(fulfilled_courses_json), pte_course_names, system_note, student_note]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Submission error:", err.message);
        res.status(500).json({ error: "Submission failed" });
    }
});

// 2. Get Applications for a Specific Student
router.get('/applications/student/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM applications WHERE student_id=$1 ORDER BY created_at DESC', [req.params.id]);
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// 3. Get ALL Applications (For Reviewer & Super Admin Dashboards)
router.get('/applications', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT a.*, u.name as student_name FROM applications a JOIN users u ON a.student_id=u.id ORDER BY a.created_at DESC`
        );
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// 4. Update Application Status (Reviewer Action)
router.put('/applications/:id/status', async (req, res) => {
    try {
        await pool.query(
            'UPDATE applications SET status=$1, reviewer_note=$2 WHERE id=$3', 
            [req.body.status, req.body.note, req.params.id]
        );
        // Note: If you added the email notification function here earlier, ensure it's still here!
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Update failed" });
    }
});

// 5. Resubmit Application (Phase 3: The Two-Way Loop)
router.put('/applications/:id/resubmit', async (req, res) => {
    const { id } = req.params;
    const { student_resubmit_note, new_files } = req.body; 
    
    try {
        // 1. Get current data to see if they already uploaded supplemental files previously
        const current = await pool.query('SELECT supplemental_files FROM applications WHERE id = $1', [id]);
        
        // 2. Append the newly uploaded file(s) to the old ones (comma separated)
        let updatedFiles = new_files;
        if (current.rows.length > 0 && current.rows[0].supplemental_files) {
            updatedFiles = current.rows[0].supplemental_files + ',' + new_files;
        }
            
        // 3. Force status to 'pending', save the reply note, and save the appended files!
        await pool.query(
            "UPDATE applications SET status = 'pending', student_resubmit_note = $1, supplemental_files = $2 WHERE id = $3", 
            [student_resubmit_note, updatedFiles, id]
        );
        
        res.json({ success: true });
    } catch (err) { 
        console.error("❌ Resubmit error:", err.message);
        res.status(500).json({ error: "Resubmit failed" }); 
    }
});

module.exports = router;