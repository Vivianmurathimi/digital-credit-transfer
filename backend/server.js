require('dotenv').config();
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

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

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

// Use the routes! 
// Note: We mount 'uploadRoutes' at the root ('/') because the routes inside already say '/api/upload' and '/transcripts'
app.use('/api', authRoutes);
app.use('/api', dataRoutes);
app.use('/api', applicationRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/settings', settingsRoutes);

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});