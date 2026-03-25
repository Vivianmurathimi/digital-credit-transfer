const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/users', async (req, res) => {
    try {
        const result = await pool.query("SELECT id,name,email,role FROM users WHERE role!='superadmin'");
        res.json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch users failed" });
    }
});

router.get('/pte-courses', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM courses');
        res.json({ success: true, courses: result.rows });
    } catch {
        res.status(500).json({ error: "Fetch failed" });
    }
});

module.exports = router;