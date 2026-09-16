const express = require('express');
const path = require('path');
const router = express.Router();
const multer = require('multer');
const minioClient = require('../minio');
const verifyToken = require('../middleware/verifyToken');

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
 * UPLOAD ROUTE — must be logged in. Tags the file with the uploader's ID
 * as metadata, so ownership can be checked later on delete.
 */
router.post('/', verifyToken, upload.single('file'), async (req, res) => {
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
 * DELETE ROUTE — must be logged in. A student may only delete their OWN
 * uploaded files. Reviewers/superadmins may delete any file.
 */
router.delete('/:filename', verifyToken, async (req, res) => {
    try {
        const stat = await minioClient.statObject(BUCKET_NAME, req.params.filename);
        const uploaderId = stat.metaData['x-amz-meta-uploader-id'];

        const isOwner = uploaderId && parseInt(uploaderId, 10) === req.user.id;
        const isPrivileged = req.user.role === 'reviewer' || req.user.role === 'superadmin';

        if (!isOwner && !isPrivileged) {
            return res.status(403).json({ error: 'You can only delete your own files' });
        }

        await minioClient.removeObject(BUCKET_NAME, req.params.filename);
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Delete error:", err.message);
        res.status(500).json({ error: "Delete failed" });
    }
});


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