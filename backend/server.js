require('dotenv').config();
// Checks JWT_SECRET first: the server refuses to start without it
require('./config/jwt');
// Checks FRONTEND_URL / CORS_ORIGINS (required in production)
const { CORS_ORIGINS } = require('./config/urls');
// Checks the RATE_LIMIT_* settings
require('./utils/rateLimit');
const express = require('express');
const cors = require('cors');

// Import your configuration files
const { listPendingMigrations } = require('./utils/migrations');
const minioClient = require('./minio');

// Import your new modular routes
const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const applicationRoutes = require('./routes/applications');
const uploadRoutes = require('./routes/uploads');
const settingsRoutes = require('./routes/settings');
const archiveRoutes = require('./routes/archive');

const app = express();

// Behind a reverse proxy (e.g. nginx) every request seems to come from the proxy, which would
// put all users in one rate-limit bucket. TRUST_PROXY is the NUMBER of proxies in front of the
// app (e.g. 1). Express then takes the client IP that many steps back in X-Forwarded-For;
// anything a client adds further left is ignored, so the header cannot be faked to dodge limits.
// "true" would trust the whole header (fakeable), so only whole numbers are accepted.
const proxyHops = process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 0;
if (!Number.isInteger(proxyHops) || proxyHops < 0) {
    throw new Error(`TRUST_PROXY in backend/.env must be a number of proxy hops (e.g. 1), got "${process.env.TRUST_PROXY}"`);
}
if (proxyHops > 0) app.set('trust proxy', proxyHops);

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

// The schema is managed by migrations (backend/migrations, `npm run migrate`).
// Checked BEFORE listening: pending migrations stop the server in production,
// so it never answers a request with an outdated schema; in development they only warn.
listPendingMigrations()
    .catch((err) => {
        console.error('❌ Could not check database migrations:', err.message);
        return [];
    })
    .then((pending) => {
        if (pending.length > 0) {
            const message = `Pending database migrations: ${pending.join(', ')}. Run "npm run migrate" in backend/.`;
            if (process.env.NODE_ENV === 'production') {
                console.error(`❌ ${message}`);
                process.exit(1);
            }
            console.warn(`⚠️  ${message}`);
        }
        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });
    });