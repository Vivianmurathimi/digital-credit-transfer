require('dotenv').config(); 
const express = require('express'); 
const cors = require('cors'); 
const pool = require('./db'); 
const minioClient = require('./minio'); 
const bcrypt = require('bcryptjs'); // 🛡️ Security guard (globally imported)
const jwt = require('jsonwebtoken'); // 🎫 Digital Badge Maker (globally imported)
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() }); 

const app = express();
app.use(express.json()); 
app.use(cors()); 

// --- HEALTH & TEST ROUTES ---

// Door 1: The Health Check
app.get('/api/health', (req, res) => {
    res.json({ message: "The Digital Credit Transfer backend is officially ALIVE!" });
});

// Door 2: The Database Test
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()'); 
        res.json({ 
            success: true, 
            message: "Node.js successfully talked to PostgreSQL!",
            databaseTime: result.rows.now 
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to talk to the database" });
    }
});

// Door 3: The Storage Test
app.get('/api/test-storage', async (req, res) => {
    try {
        const buckets = await minioClient.listBuckets();
        res.json({
            success: true,
            message: "Node.js successfully talked to MinIO Storage!",
            buckets: buckets
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to talk to storage" });
    }
});


// --- AUTHENTICATION ROUTES ---

// USER REGISTRATION
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body; 

    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ error: 'An account with this email already exists!' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = await pool.query(
            'INSERT INTO users (full_name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, email, role',
            [name, email, hashedPassword, 'student']
        );

        res.status(201).json({ message: '✅ Registration successful! You can now log in.' });
    } catch (error) {
        console.error('Registration Error:', error);
        res.status(500).json({ error: 'Server error during registration.' });
    }
});

// USER LOGIN
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        // 🐛 THE FIX: Added to grab the first user object!
        const user = userResult.rows[0];

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid email or password.' });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET || 'fallback_backup_secret_do_not_use_in_production', 
            { expiresIn: '2h' } 
        );

        res.json({ 
            message: 'Login successful',
            token: token,
            user: { 
                id: user.id, 
                email: user.email, 
                role: user.role 
            }
        });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ error: 'Server error during login.' });
    }
});


// --- ADMIN ROUTES ---

// Get all users
app.get('/api/users', async (req, res) => {
    try {
        const allUsers = await pool.query('SELECT id, full_name, email, role FROM users ORDER BY id ASC');
        res.json(allUsers.rows);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Server error fetching users.' });
    }
});

// Update user role
app.put('/api/users/:id/role', async (req, res) => {
    const userId = req.params.id;
    const { role } = req.body; 
    
    try {
        await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
        res.json({ message: `✅ User ${userId} successfully updated to ${role}!` });
    } catch (error) {
        console.error('Error updating role:', error);
        res.status(500).json({ error: 'Server error updating role.' });
    }
});


// --- STUDENT ROUTES ---

// Document Upload Door
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: "No file was uploaded." });
        }

        const uniqueFileName = `${Date.now()}-${file.originalname}`;
        const bucketName = 'transcripts';

        const bucketExists = await minioClient.bucketExists(bucketName);
        if (!bucketExists) {
            await minioClient.makeBucket(bucketName);
            console.log(`🪣 Created new MinIO bucket: ${bucketName}`);
        }

        await minioClient.putObject(bucketName, uniqueFileName, file.buffer, file.size, {
            'Content-Type': file.mimetype
        });

        res.status(200).json({
            success: true,
            message: "File successfully uploaded to MinIO!",
            fileName: uniqueFileName
        });

    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ error: "Failed to upload file." });
    }
});

// Fetch PTE Course Catalog
app.get('/api/pte-courses', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.id, c.course_code, c.course_name, c.credits 
            FROM courses c
            JOIN universities u ON c.university_id = u.id
            WHERE u.name = 'University of Pécs (PTE)'
        `);
        res.json({ success: true, courses: result.rows });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});
// POST /api/applications - Submit a credit transfer application
app.post('/api/applications', async (req, res) => {
    // React is handing us the data...
    const { student_id, previous_course, pte_course_id, syllabus_file } = req.body;

    try {
        // 👇 Look right here! We changed previous_course to fulfilled_course in the database! 👇
        const newApp = await pool.query(
            `INSERT INTO applications (student_id, fulfilled_course, pte_course_id, syllabus_file, status) 
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [student_id, previous_course, pte_course_id, syllabus_file, 'pending']
        );
        
        res.status(201).json({ success: true, message: 'Application submitted successfully!', application: newApp.rows[0] });
    } catch (error) {
        console.error('Submit Application Error:', error);
        res.status(500).json({ error: 'Failed to submit application.' });
    }
});
    // --- STUDENT: Fetch only their own applications ---
app.get('/api/applications/student/:studentId', async (req, res) => {
    const { studentId } = req.params;
    try {
        const result = await pool.query(`
            SELECT 
                a.id, 
                a.fulfilled_course, 
                c.course_name as pte_course_name, 
                a.syllabus_file, 
                a.status, 
                TO_CHAR(a.created_at, 'YYYY-MM-DD') as date_submitted
            FROM applications a
            JOIN courses c ON a.pte_course_id = c.id
            WHERE a.student_id = $1
            ORDER BY a.created_at DESC
        `, [studentId]);
        
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error("Student Fetch Error:", err);
        res.status(500).json({ error: "Failed to fetch student applications" });
    }
});
// --- REVIEWER: Fetch all applications with Student Names and PTE Course Names ---
app.get('/api/applications', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                a.id, 
                u.full_name as student_name, 
                a.fulfilled_course, 
                c.course_name as pte_course_name, 
                a.syllabus_file, 
                a.status, 
                a.created_at
            FROM applications a
            JOIN users u ON a.student_id = u.id
            JOIN courses c ON a.pte_course_id = c.id
            ORDER BY a.created_at DESC
        `);
            // --- REVIEWER: Approve or Reject an Application ---
        app.put('/api/applications/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // Expects 'approved' or 'rejected'

    try {
        await pool.query(
            'UPDATE applications SET status = $1 WHERE id = $2',
            [status, id]
        );
        res.json({ success: true, message: `Application ${status} successfully!` });
    } catch (err) {
        console.error("Status Update Error:", err);
        res.status(500).json({ error: "Failed to update status." });
    }
});
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch applications" });
    }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Backend Server is running on http://localhost:${PORT}`);
});