require('dotenv').config();
// Checks JWT_SECRET first: the server refuses to start without it
require('./config/jwt');
// Checks FRONTEND_URL / CORS_ORIGINS (required in production)
const { CORS_ORIGINS } = require('./config/urls');
const express = require('express');
const cors = require('cors');

// Import your configuration files
const pool = require('./db');
const minioClient = require('./minio');

// Import your new modular routes
const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const applicationRoutes = require('./routes/applications');
const uploadRoutes = require('./routes/uploads');
const settingsRoutes = require('./routes/settings');
const archiveRoutes = require('./routes/archive');

const app = express();

// Middleware
app.use(express.json());
// Only the frontend's own address may call the API from a browser.
// A refused origin simply gets no CORS headers (the browser blocks it), not an error.
// Requests without an Origin (curl, server-to-server) are not affected by CORS at all.
app.use(cors({
    origin: (origin, callback) => callback(null, !origin || CORS_ORIGINS.includes(origin)),
    exposedHeaders: ['Content-Disposition'], // lets the browser read download file names
}));

// MinIO Bucket Initialization
const BUCKET_NAME = 'transcripts';
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

const ensureApplicationResubmitColumns = async () => {
    try {
        await pool.query(`ALTER TABLE IF EXISTS applications ADD COLUMN IF NOT EXISTS student_resubmit_note TEXT;`);
        await pool.query(`ALTER TABLE IF EXISTS applications ADD COLUMN IF NOT EXISTS supplemental_files TEXT;`);
        console.log('✅ Ensured applications table has resubmit columns');
    } catch (err) {
        console.error('❌ Could not ensure resubmit columns:', err.message);
    }
};

ensureApplicationResubmitColumns();

// Language used for the student's notification emails (Hungarian by default)
const ensureUserLanguageColumn = async () => {
    try {
        await pool.query(`ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(5) DEFAULT 'hu';`);
        console.log('✅ Ensured users table has preferred_language column');
    } catch (err) {
        console.error('❌ Could not ensure preferred_language column:', err.message);
    }
};

ensureUserLanguageColumn();

// Who made the last status decision and when (shown in the term archive book)
const ensureApplicationReviewColumns = async () => {
    try {
        await pool.query(`ALTER TABLE IF EXISTS applications ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;`);
        await pool.query(`ALTER TABLE IF EXISTS applications ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;`);
        console.log('✅ Ensured applications table has reviewed_by / reviewed_at columns');
    } catch (err) {
        console.error('❌ Could not ensure review columns:', err.message);
    }
};

ensureApplicationReviewColumns();

// Use the routes! 
// Note: We mount 'uploadRoutes' at the root ('/') because the routes inside already say '/api/upload' and '/transcripts'
app.use('/api', authRoutes);
app.use('/api', dataRoutes);
app.use('/api', applicationRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/archive', archiveRoutes);

// Start Server
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});