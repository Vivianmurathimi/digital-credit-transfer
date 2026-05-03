const express = require('express');
const path = require('path');
const router = express.Router();
const multer = require('multer');
const minioClient = require('../minio');

const BUCKET_NAME = 'transcripts';
const upload = multer({ storage: multer.memoryStorage() });

const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

const getContentType = (filename) => MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream';

// Helper to ensure bucket exists
const ensureBucket = async () => {
    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
        await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
        console.log(`Bucket "${BUCKET_NAME}" created.`);
    }
};
ensureBucket().catch(err => console.error("MinIO Bucket Error:", err));

/**
 * UPLOAD ROUTE
 * Handles: 
 * 1. Initial application syllabus (Phase 1)
 * 2. Highlighted images from Canvas (Phase 1 & 3)
 * 3. Raw PDF/Docs resubmissions (Phase 3)
 */
router.post('/', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file received by backend" });
    }

    // Clean filename: timestamp + original name
    const fileName = `${Date.now()}-${req.file.originalname.replace(/\s/g, '_')}`;

    try {
        await minioClient.putObject(
            BUCKET_NAME, 
            fileName, 
            req.file.buffer, 
            req.file.size, 
            { 'Content-Type': req.file.mimetype }
        );

        console.log(`✅ File saved to MinIO: ${fileName}`);
        res.json({ success: true, fileName });
    } catch (err) {
        console.error("❌ MinIO PutObject Error:", err.message);
        res.status(500).json({ error: "Upload failed at storage server" });
    }
});

/**
 * DELETE ROUTE
 */
router.delete('/:filename', async (req, res) => {
    try {
        await minioClient.removeObject(BUCKET_NAME, req.params.filename);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Delete failed" });
    }
});

/**
 * FETCH ROUTE (Proxy from MinIO to Frontend)
 * This allows the <img src="..."> to work
 */
router.get('/:filename', async (req, res) => {
    try {
        const stream = await minioClient.getObject(BUCKET_NAME, req.params.filename);
        const contentType = getContentType(req.params.filename);
        res.setHeader('Content-Type', contentType);
        stream.pipe(res);
    } catch (err) {
        console.error("❌ File Fetch Error:", err.message);
        res.status(404).send("File not found");
    }
});

module.exports = router;