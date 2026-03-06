require('dotenv').config(); 
const express = require('express'); 
const cors = require('cors'); 
const pool = require('./db'); 
const minioClient = require('./minio'); // 🔌 NEW: Plugging in the MinIO cable!
const bcrypt = require('bcryptjs'); // 🛡️ Our new security guard
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() }); // Catches the file in computer memory temporarily
const jwt = require('jsonwebtoken'); // 🎫 The Digital Badge Maker
const app = express();
app.use(express.json()); 
app.use(cors()); 

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
            databaseTime: result.rows[0].now 
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to talk to the database" });
    }
});

// Door 3: 🔌 NEW: The Storage Test
app.get('/api/test-storage', async (req, res) => {
    try {
        // We are asking MinIO for a list of all our file buckets
        const buckets = await minioClient.listBuckets();
        res.json({
            success: true,
            message: "Node.js successfully talked to MinIO Storage!",
            buckets: buckets // This will be an empty array [] right now, which is perfect!
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to talk to storage" });
    }
});
// Door 4: 🔌 NEW: Fetch all users
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name, email, role, created_at FROM users');
        res.json({
            success: true,
            users: result.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch users" });
    }
});
// Door 5: The Registration Door (POST - Receiving Data)
app.post('/api/register', async (req, res) => {
    try {
        // 1. Open the digital envelope from the Frontend
        const { fullName, email, password, role } = req.body;

        // 2. The Security Guard scrambles the password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 3. Send the scrambled data down the db.js cable to PostgreSQL
        const insertQuery = `
            INSERT INTO users (full_name, email, password, role) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, full_name, email, role; 
        `;
        // Notice we are saving the 'hashedPassword', NOT the real password!
        const result = await pool.query(insertQuery, [fullName, email, hashedPassword, role || 'student']);

        // 4. Send the successful receipt back to the Frontend
        res.status(201).json({
            success: true,
            message: "Student account created successfully!",
            user: result.rows[0]
        });

    } catch (err) {
        console.error("Registration Error:", err);
        // 23505 is the specific Postgres code for "This email already exists"
        if (err.code === '23505') { 
            return res.status(400).json({ error: "This email is already registered." });
        }
        res.status(500).json({ error: "Failed to register user." });
    }
});
// Door 6: The Document Upload Door
// Notice we use "upload.single('file')" - this tells the catcher to look for one file named "file"
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: "No file was uploaded." });
        }

        // 1. Create a unique name for the file so we don't accidentally overwrite anything
        const uniqueFileName = `${Date.now()}-${file.originalname}`;
        const bucketName = 'transcripts';

        // 2. Check if the "transcripts" bucket exists in MinIO. If not, build it!
        const bucketExists = await minioClient.bucketExists(bucketName);
        if (!bucketExists) {
            await minioClient.makeBucket(bucketName);
            console.log(`🪣 Created new MinIO bucket: ${bucketName}`);
        }

        // 3. Send the file down the cable to MinIO
        await minioClient.putObject(bucketName, uniqueFileName, file.buffer, file.size, {
            'Content-Type': file.mimetype
        });

        // 4. Send the success receipt back
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
// Door 7: The Login Door (POST - Checking Data)
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // 1. Ask the database if this email even exists
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: "Invalid email or password." }); // 401 means Unauthorized
        }
        
        const user = userResult.rows[0];

        // 2. Have the Security Guard check if the password matches the scrambled one in the database
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid email or password." });
        }

        // 3. Passwords match! Print the Digital ID Badge (JWT)
        const token = jwt.sign(
            { id: user.id, role: user.role }, // Information inside the badge
            process.env.JWT_SECRET,           // The secret stamp
            { expiresIn: '2h' }               // The badge expires in 2 hours for security
        );

        // 4. Hand the badge to the React Frontend
        res.json({
            success: true,
            message: "Login successful!",
            token: token, // <-- This is the magic badge!
            user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role }
        });

    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ error: "Failed to log in." });
    }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Backend Server is running on http://localhost:${PORT}`);
});