const express = require('express');
const router = express.Router();
const multer = require('multer');
const minioClient = require('../minio'); // Goes up one directory to find minio.js

const BUCKET_NAME = 'transcripts';
const upload = multer({ storage: multer.memoryStorage() });

// UPLOAD
router.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const fileName = Date.now() + '-' + req.file.originalname;
    try {
        await minioClient.putObject(BUCKET_NAME, fileName, req.file.buffer, req.file.size, { 'Content-Type': req.file.mimetype });
        res.json({ success: true, fileName });
    } catch (err) {
        res.status(500).json({ error: "Upload failed" });
    }
});

// DELETE
router.delete('/api/upload/:filename', async (req, res) => {
    try {
        await minioClient.removeObject(BUCKET_NAME, req.params.filename);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Delete failed" });
    }
});

// FETCH
router.get('/transcripts/:filename', async (req, res) => {
    try {
        const stream = await minioClient.getObject(BUCKET_NAME, req.params.filename);
        stream.pipe(res);
    } catch (err) {
        res.status(404).send("File not found");
    }
});

module.exports = router;