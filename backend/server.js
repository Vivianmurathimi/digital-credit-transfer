require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ✅ MINIO
const minioClient = require('./minio');
const BUCKET_NAME = 'transcripts';

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
    if (err) console.error('❌ Database connection failed:', err.stack);
    else {
        console.log('✅ Connected to PostgreSQL!');
        release();
    }
});

// --- MINIO CONFIG ---

// Store files in memory instead of disk
const upload = multer({ storage: multer.memoryStorage() });

// Ensure bucket exists
minioClient.bucketExists(BUCKET_NAME, (err, exists) => {
    if (err) return console.error('❌ MinIO Connection Error:', err);

    if (!exists) {
        minioClient.makeBucket(BUCKET_NAME, 'us-east-1', (err) => {
            if (err) return console.error('❌ Error creating bucket:', err);
            console.log(`🪣 Created bucket: ${BUCKET_NAME}`);
        });
    } else {
        console.log(`🪣 Connected to bucket: ${BUCKET_NAME}`);
    }
});

// --- AUTH ROUTES ---

app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;

    try {
        let assignedRole = '';
        const lowerEmail = email.toLowerCase();

        if (lowerEmail.endsWith('@mik.pte.hu')) {
            assignedRole = 'reviewer';
        } else if (lowerEmail.endsWith('@tr.pte.hu')) {
            assignedRole = 'student';
        } else if (lowerEmail.endsWith('@admin.pte.hu')) {
            assignedRole = 'superadmin';
        } else {
            return res.status(400).json({
                error: "Invalid domain. Use @mik or @tr email."
            });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const result = await pool.query(
            'INSERT INTO users (name, email, password, role) VALUES ($1,$2,$3,$4) RETURNING id,name,role',
            [name, lowerEmail, hashedPassword, assignedRole]
        );

        res.json({ success: true, user: result.rows[0] });

    } catch (err) {
        console.error("❌ Registration Error:", err.message);

        if (err.code === '23505') {
            return res.status(400).json({ error: "Email already exists" });
        }

        res.status(500).json({ error: "Registration failed" });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email=$1',
            [email.toLowerCase()]
        );

        if (result.rows.length === 0)
            return res.status(401).json({ error: "Invalid credentials" });

        const user = result.rows[0];

        const match = await bcrypt.compare(password, user.password);
        if (!match)
            return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET || 'secret_key',
            { expiresIn: '1h' }
        );

        res.json({ success: true, token, role: user.role });

    } catch (err) {
        console.error("❌ Login Error:", err.message);
        res.status(500).json({ error: "Login failed" });
    }
});

// --- USERS ---
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id,name,email,role FROM users WHERE role!='superadmin'"
        );
        res.json({ success: true, users: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Fetch users failed" });
    }
});

// --- COURSES ---
app.get('/api/pte-courses', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM courses');
        res.json({ success: true, courses: result.rows });
    } catch {
        res.status(500).json({ error: "Fetch failed" });
    }
});

// --- APPLICATIONS ---
app.post('/api/applications', async (req, res) => {
    const {
        student_id,
        previous_course,
        fulfilled_course_code,
        fulfilled_credits,
        fulfilled_grade,
        pte_course_names,
        syllabus_file,
        system_note
    } = req.body;

    try {
        await pool.query(
            `INSERT INTO applications 
            (student_id, fulfilled_course, fulfilled_course_code, fulfilled_credits, fulfilled_grade, pte_course_names, syllabus_file, system_note, status) 
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
            [
                student_id,
                previous_course,
                fulfilled_course_code,
                fulfilled_credits,
                fulfilled_grade,
                pte_course_names,
                syllabus_file,
                system_note
            ]
        );

        res.json({ success: true });

    } catch (err) {
        res.status(500).json({ error: "Submission failed" });
    }
});

app.get('/api/applications/student/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM applications WHERE student_id=$1 ORDER BY created_at DESC',
            [req.params.id]
        );
        res.json({ success: true, applications: result.rows });
    } catch {
        res.status(500).json({ error: "Fetch failed" });
    }
});

app.get('/api/applications', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT a.*, u.name as student_name 
             FROM applications a 
             JOIN users u ON a.student_id=u.id`
        );
        res.json({ success: true, applications: result.rows });
    } catch {
        res.status(500).json({ error: "Fetch failed" });
    }
});

app.put('/api/applications/:id/status', async (req, res) => {
    try {
        await pool.query(
            'UPDATE applications SET status=$1, reviewer_note=$2 WHERE id=$3',
            [req.body.status, req.body.note, req.params.id]
        );
        res.json({ success: true });
    } catch {
        res.status(500).json({ error: "Update failed" });
    }
});

// --- MINIO FILE ROUTES ---

// UPLOAD
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: "No file uploaded" });

    const fileName = Date.now() + '-' + req.file.originalname;

    try {
        await minioClient.putObject(
            BUCKET_NAME,
            fileName,
            req.file.buffer,
            req.file.size,
            { 'Content-Type': req.file.mimetype }
        );

        res.json({ success: true, fileName });

    } catch (err) {
        console.error("❌ Upload Error:", err);
        res.status(500).json({ error: "Upload failed" });
    }
});

// DELETE
app.delete('/api/upload/:filename', async (req, res) => {
    try {
        await minioClient.removeObject(BUCKET_NAME, req.params.filename);
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Delete Error:", err);
        res.status(500).json({ error: "Delete failed" });
    }
});

// FETCH
app.get('/transcripts/:filename', async (req, res) => {
    try {
        const stream = await minioClient.getObject(
            BUCKET_NAME,
            req.params.filename
        );
        stream.pipe(res);
    } catch (err) {
        console.error("❌ Fetch Error:", err);
        res.status(404).send("File not found");
    }
});

// --- SERVER ---
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});