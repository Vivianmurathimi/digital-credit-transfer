const express = require('express');
const path = require('path');
const router = express.Router();
const multer = require('multer');
const minioClient = require('../minio');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { getFileOwner } = require('../utils/fileOwner');

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
 * UPLOAD ROUTE — students only (evidence). Tags the file with the uploader's ID
 * as metadata, so ownership can be checked later on delete.
 */
router.post('/', verifyToken, requireRole('student'), upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file received by backend" });
    }

    const fileName = `${Date.now()}-${req.file.originalname.replace(/\s/g, '_')}`;

    try {
        await minioClient.putObject(
            BUCKET_NAME, 
            fileName, 
            req.file.buffer, 
            req.file.size, 
            { 
                'Content-Type': req.file.mimetype,
                'X-Amz-Meta-Uploader-Id': String(req.user.id),
                'X-Amz-Meta-Uploader-Role': req.user.role
            }
        );

        console.log(`✅ File saved to MinIO: ${fileName} (uploaded by user ${req.user.id})`);
        res.json({ success: true, fileName });
    } catch (err) {
        console.error("❌ MinIO PutObject Error:", err.message);
        res.status(500).json({ error: "Upload failed at storage server" });
    }
});

/**
 * DELETE ROUTE — students only, and only their OWN uploaded files.
 * Nobody else can delete a student's evidence, so the audit trail stays intact.
 */
router.delete('/:filename', verifyToken, requireRole('student'), async (req, res) => {
    try {
        const { exists, ownerId } = await getFileOwner(req.params.filename);
        if (!exists) {
            return res.status(404).json({ error: 'File not found' });
        }

        if (ownerId !== req.user.id) {
            return res.status(403).json({ error: 'You can only delete your own files' });
        }

        await minioClient.removeObject(BUCKET_NAME, req.params.filename);
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Delete error:", err.message);
        res.status(500).json({ error: "Delete failed" });
    }
});


/**
 * VIEW ROUTE — must be logged in. The student who uploaded the file can view it,
 * and so can reviewers and the superadmin (they review every application for now).
 */
router.get('/:filename', verifyToken, async (req, res) => {
    try {
        const { exists, ownerId } = await getFileOwner(req.params.filename);
        if (!exists) {
            return res.status(404).json({ error: 'File not found' });
        }

        const isOwner = ownerId === req.user.id;
        const isStaff = req.user.role === 'reviewer' || req.user.role === 'superadmin';
        if (!isOwner && !isStaff) {
            return res.status(403).json({ error: 'You can only view your own files' });
        }

        const stream = await minioClient.getObject(BUCKET_NAME, req.params.filename);
        res.setHeader('Content-Type', getContentType(req.params.filename));
        stream.on('error', (err) => {
            console.error('❌ File stream error:', err.message);
            res.destroy(err);
        });
        stream.pipe(res);
    } catch (err) {
        console.error("❌ File Fetch Error:", err.message);
        res.status(500).json({ error: 'Could not load the file' });
    }
});

module.exports = router;