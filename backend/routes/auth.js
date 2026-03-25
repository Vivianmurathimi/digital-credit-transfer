const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db'); // Uses your existing db.js

router.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        let assignedRole = '';
        const lowerEmail = email.toLowerCase();

        if (lowerEmail.endsWith('@mik.pte.hu')) assignedRole = 'reviewer';
        else if (lowerEmail.endsWith('@tr.pte.hu')) assignedRole = 'student';
        else if (lowerEmail.endsWith('@admin.pte.hu')) assignedRole = 'superadmin';
        else return res.status(400).json({ error: "Invalid domain. Use @mik or @tr email." });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const result = await pool.query(
            'INSERT INTO users (name, email, password, role) VALUES ($1,$2,$3,$4) RETURNING id,name,role',
            [name, lowerEmail, hashedPassword, assignedRole]
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "Email already exists" });
        res.status(500).json({ error: "Registration failed" });
    }
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET || 'secret_key',
            { expiresIn: '1h' }
        );
        res.json({ success: true, token, role: user.role });
    } catch (err) {
        res.status(500).json({ error: "Login failed" });
    }
});

module.exports = router;