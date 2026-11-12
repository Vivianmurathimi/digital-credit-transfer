const express = require('express');
const path = require('path');
const router = express.Router();
const multer = require('multer');
const minioClient = require('../minio');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { getFileOwner, isFileInProgramme, isFileInUse } = require('../utils/fileOwner');
const pool = require('../db');
const crypto = require('crypto');
const sendError = require('../utils/sendError');
const {
    MAX_UPLOAD_BYTES, detectFileType, maxBytesFor, megabytes, cleanOriginalName, encodeForMetadata, contentDisposition,
} = require('../utils/fileRules');

const { EVIDENCE_BUCKET: BUCKET_NAME } = require('../config/buckets');
// Files stay in memory until every check has passed, so a refused upload never reaches storage.
// The size limit makes multer stop reading as soon as a file is larger than the highest limit.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 100 },
    defParamCharset: 'utf8', // file names with accents (e.g. "tantárgyleírás.pdf") arrive intact
});

const tooLarge = (req, res, maxBytes) => {
    // The rest of an oversized body is read and thrown away (never kept in memory), so the
    // sender can finish and actually receive this answer instead of a broken connection
    req.resume();
    return sendError(res, 413, 'FILE_TOO_LARGE', `The file is larger than ${megabytes(maxBytes)} MB`, { errors: [{ field: 'file', code: 'FILE_TOO_LARGE', error: `The file is larger than ${megabytes(maxBytes)} MB`, params: { max: megabytes(maxBytes) } }] });
};

// Receives one file. A request that announces more than the highest limit is refused before
// anything is read; one that turns out larger while reading is stopped at the limit.
const receiveFile = (req, res, next) => {
    const announced = Number(req.headers['content-length']);
    if (Number.isFinite(announced) && announced > MAX_UPLOAD_BYTES + 64 * 1024) return tooLarge(req, res, MAX_UPLOAD_BYTES);
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') return tooLarge(req, res, MAX_UPLOAD_BYTES);
        return sendError(res, 400, 'NO_FILE', 'The upload could not be read');
    });
};

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
 * UPLOAD ROUTE — students only. Checks size and real content, stores the file under a
 * generated name, and tags it with the uploader (for ownership checks) and the original name.
 * Form fields: kind = 'highlighted' (saved by the highlighter, up to 15 MB) or anything else
 * (uploaded unchanged, up to 10 MB); file = the file.
 */
router.post('/', verifyToken, requireRole('student'), receiveFile, async (req, res) => {
    if (!req.file) {
        return sendError(res, 400, 'NO_FILE', 'No file received by backend');
    }

    const maxBytes = maxBytesFor(req.body.kind);
    if (req.file.size > maxBytes) return tooLarge(req, res, maxBytes);

    const type = detectFileType(req.file.buffer, req.file.originalname);
    if (!type) {
        return sendError(res, 400, 'FILE_TYPE_NOT_ALLOWED', 'Only PDF, JPG and PNG files are allowed', { errors: [{ field: 'file', code: 'FILE_TYPE_NOT_ALLOWED', error: 'Only PDF, JPG and PNG files are allowed' }] });
    }

    // A generated name: nothing the student typed (like "/" or "..") ever reaches storage
    const fileName = `${crypto.randomUUID()}.${type.ext}`;
    const originalName = cleanOriginalName(req.file.originalname);

    try {
        await minioClient.putObject(
            BUCKET_NAME, 
            fileName, 
            req.file.buffer, 
            req.file.size, 
            { 
                'Content-Type': type.mime, // from the content, not from the browser
                'X-Amz-Meta-Uploader-Id': String(req.user.id),
                'X-Amz-Meta-Uploader-Role': req.user.role,
                'X-Amz-Meta-Original-Name': encodeForMetadata(originalName),
                // Uploaded by the admin acting as the student (admin round Group 1): the file is the
                // student's (so they can use it), and this tag records who really uploaded it
                ...(req.acting ? { 'X-Amz-Meta-Acted-By-Admin': String(req.actor.id) } : {}),
            }
        );

        console.log(`✅ File saved to MinIO: ${fileName} (uploaded by user ${req.user.id})`);
        res.json({ success: true, fileName, originalName });
    } catch (err) {
        console.error("❌ MinIO PutObject Error:", err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Upload failed at storage server');
    }
});

/**
 * DELETE ROUTE — students only, only their OWN uploaded files, and only files no submitted
 * application uses (those are evidence: 409 FILE_IN_USE).
 * Nobody else can delete a student's evidence, so the audit trail stays intact.
 */
router.delete('/:filename', verifyToken, requireRole('student'), async (req, res) => {
    try {
        const { exists, ownerId } = await getFileOwner(req.params.filename);
        if (!exists) {
            return sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
        }

        if (ownerId !== req.user.id) {
            return sendError(res, 403, 'NOT_OWNER', 'You can only delete your own files');
        }
        // A file a submitted application uses (any status, any semester) stays: it is that
        // application's evidence, also for past semesters (reviewer group L3)
        if (await isFileInUse(pool, req.params.filename)) {
            return sendError(res, 409, 'FILE_IN_USE', 'This file belongs to a submitted application and cannot be deleted');
        }

        await minioClient.removeObject(BUCKET_NAME, req.params.filename);
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Delete error:", err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Delete failed');
    }
});


/**
 * VIEW ROUTE — must be logged in. The student who uploaded the file can view it, and so can
 * the superadmin. A reviewer only when an application of their own programme refers to it
 * (reviewer Group 2); for any other file they get "not found", the same as for a missing one.
 */
router.get('/:filename', verifyToken, async (req, res) => {
    try {
        const { exists, ownerId, originalName } = await getFileOwner(req.params.filename);
        if (!exists) {
            return sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
        }

        const isOwner = ownerId === req.user.id;
        if (!isOwner && req.user.role === 'reviewer') {
            if (!(await isFileInProgramme(pool, req.params.filename, req.user.programmeIds))) {
                return sendError(res, 404, 'FILE_NOT_FOUND', 'File not found');
            }
        } else if (!isOwner && req.user.role !== 'superadmin') {
            return sendError(res, 403, 'NOT_OWNER', 'You can only view your own files');
        }

        const stream = await minioClient.getObject(BUCKET_NAME, req.params.filename);
        res.setHeader('Content-Type', getContentType(req.params.filename));
        // Downloads keep the name the student chose, accents included
        res.setHeader('Content-Disposition', contentDisposition(originalName || req.params.filename));
        stream.on('error', (err) => {
            console.error('❌ File stream error:', err.message);
            res.destroy(err);
        });
        stream.pipe(res);
    } catch (err) {
        console.error("❌ File Fetch Error:", err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not load the file');
    }
});

module.exports = router;