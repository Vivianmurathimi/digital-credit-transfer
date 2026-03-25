require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // 🔐 Required for password hashing

const app = express();
app.use(express.json());
app.use(cors());

// --- DATABASE CONNECTION ---
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection failed:', err.stack);
    } else {
        console.log('✅ Successfully connected to the PostgreSQL database!');
        release();
    }
});

// --- FILE UPLOAD CONFIG (Multer) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'transcripts/'); 
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });
app.use('/transcripts', express.static(path.join(__dirname, 'transcripts')));

// --- AUTHENTICATION ROUTES (🔐 SECURED WITH BCRYPT) ---

app.post('/api/register', async (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const result = await pool.query(
            'INSERT INTO users (full_name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, full_name, role',
            [name, email, hashedPassword, role || 'student']
        );
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error("❌ DB Registration Error:", err.detail || err.message); 
        res.status(500).json({ error: "Registration failed" });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        
        // Guard clause 1: User not found
        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);

        // Guard clause 2: Passwords don't match
        if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign({ id: user.id, role: user.role }, 'secret_key', { expiresIn: '1h' });
        res.json({ success: true, token, role: user.role });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Login failed" });
    }
});

// --- USER & IMPERSONATION ROUTES ---

app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, full_name, email, role FROM users WHERE role != 'superadmin' ORDER BY role, full_name"
        );
        res.json({ success: true, users: result.rows });
    } catch (err) {
        console.error("Fetch users error:", err);
        res.status(500).json({ error: "Could not fetch users" });
    }
});

// --- COURSE & DATA ROUTES ---

app.get('/api/pte-courses', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM courses');
        res.json({ success: true, courses: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch courses failed" });
    }
});

// --- APPLICATION & PENDING LOOP ROUTES ---

app.post('/api/applications', async (req, res) => {
    const { student_id, previous_course, fulfilled_course_code, fulfilled_credits, fulfilled_grade, pte_course_ids, syllabus_file, system_note } = req.body;
    try {
        for (let pte_id of pte_course_ids) {
            await pool.query(
                `INSERT INTO applications 
                (student_id, fulfilled_course, fulfilled_course_code, fulfilled_credits, fulfilled_grade, pte_course_id, syllabus_file, system_note) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [student_id, previous_course, fulfilled_course_code, fulfilled_credits, fulfilled_grade, pte_id, syllabus_file, system_note]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error("Submit error:", err);
        res.status(500).json({ error: "Submission failed" });
    }
});

app.get('/api/applications/student/:id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT a.*, c.course_name as pte_course_name 
             FROM applications a 
             JOIN courses c ON a.pte_course_id = c.id 
             WHERE a.student_id = $1`, 
            [req.params.id]
        );
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

app.get('/api/applications', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT a.*, u.full_name as student_name, c.course_name as pte_course_name 
             FROM applications a 
             JOIN users u ON a.student_id = u.id 
             JOIN courses c ON a.pte_course_id = c.id
             ORDER BY a.created_at DESC`
        );
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch failed" });
    }
});

app.put('/api/applications/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, note } = req.body;
    try {
        await pool.query(
            'UPDATE applications SET status = $1, reviewer_note = $2 WHERE id = $3',
            [status, note, id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Update failed" });
    }
});

app.put('/api/applications/:id/resubmit', async (req, res) => {
    const { id } = req.params;
    const { new_files } = req.body;
    try {
        const current = await pool.query('SELECT syllabus_file FROM applications WHERE id = $1', [id]);
        const updatedFiles = current.rows[0].syllabus_file ? current.rows[0].syllabus_file + ',' + new_files : new_files;
        
        await pool.query(
            "UPDATE applications SET status = 'pending', syllabus_file = $1 WHERE id = $2",
            [updatedFiles, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Resubmit error:", err);
        res.status(500).json({ error: "Resubmit failed" });
    }
});

// --- MISC ROUTES ---

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });
    res.json({ success: true, fileName: req.file.filename });
});

// START SERVER
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Backend Server running on http://localhost:${PORT}`);
});