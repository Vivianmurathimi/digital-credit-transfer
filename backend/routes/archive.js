const express = require('express');
const router = express.Router();
const minioClient = require('../minio');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const getTermData = require('../utils/getTermData');
const buildTermBookPdf = require('../utils/buildTermBookPdf');

// Private bucket: no public policy, books are only served through the download route below
const ARCHIVE_BUCKET = 'archives';
const BOOK_NAME = /^term-book_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_(\d+)\.pdf$/;

const ensureArchiveBucket = async () => {
    const exists = await minioClient.bucketExists(ARCHIVE_BUCKET);
    if (!exists) {
        await minioClient.makeBucket(ARCHIVE_BUCKET, 'us-east-1');
        console.log(`🪣 Created private bucket: ${ARCHIVE_BUCKET}`);
    }
};
ensureArchiveBucket().catch((err) => console.error('❌ Archive bucket error:', err.message));

// 'YYYY-MM-DD' that is also a real calendar date (rejects 2026-02-30)
const isValidDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// MinIO returns user metadata with or without the x-amz-meta- prefix depending on the call
const readMeta = (metaData, key) => metaData[`x-amz-meta-${key}`] ?? metaData[key];

const toArchiveInfo = (name, stat) => {
    const [, from, to] = name.match(BOOK_NAME);
    const meta = stat.metaData || {};
    return {
        name,
        from,
        to,
        size: stat.size,
        createdAt: stat.lastModified,
        applications: Number(readMeta(meta, 'applications')) || 0,
        pages: Number(readMeta(meta, 'pages')) || 0,
        generatedBy: readMeta(meta, 'generated-by') || null,
    };
};

// Every route here is for superadmins only
router.use(verifyToken, requireRole('superadmin'));

/**
 * POST /api/archive/generate  { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 * Builds the term book for applications submitted in that range and saves it to MinIO.
 */
router.post('/generate', async (req, res) => {
    const { from, to } = req.body;

    if (!isValidDate(from) || !isValidDate(to)) {
        return res.status(400).json({ error: 'Dates must be real dates in the format YYYY-MM-DD' });
    }
    if (from > to) {
        return res.status(400).json({ error: 'The start date must be on or before the end date' });
    }

    try {
        const data = await getTermData(from, to);
        const { buffer, pages, embeddedImages } = await buildTermBookPdf(data);

        const name = `term-book_${from}_${to}_${Date.now()}.pdf`;
        await minioClient.putObject(ARCHIVE_BUCKET, name, buffer, buffer.length, {
            'Content-Type': 'application/pdf',
            'X-Amz-Meta-Applications': String(data.total),
            'X-Amz-Meta-Pages': String(pages),
            'X-Amz-Meta-Generated-By': String(req.user.id),
        });

        console.log(`📚 Term book ${name}: ${data.total} applications, ${pages} pages, ${embeddedImages} images`);
        const stat = await minioClient.statObject(ARCHIVE_BUCKET, name);
        res.json({ success: true, archive: toArchiveInfo(name, stat) });
    } catch (err) {
        console.error('❌ Term book generation failed:', err.message);
        res.status(500).json({ error: 'Could not generate the term book' });
    }
});

/**
 * GET /api/archive
 * Lists the saved term books, newest first.
 */
router.get('/', async (req, res) => {
    try {
        const names = await new Promise((resolve, reject) => {
            const found = [];
            const stream = minioClient.listObjectsV2(ARCHIVE_BUCKET, '', true);
            stream.on('data', (obj) => { if (obj.name && BOOK_NAME.test(obj.name)) found.push(obj.name); });
            stream.on('end', () => resolve(found));
            stream.on('error', reject);
        });

        const archives = await Promise.all(
            names.map(async (name) => toArchiveInfo(name, await minioClient.statObject(ARCHIVE_BUCKET, name)))
        );
        archives.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ success: true, archives });
    } catch (err) {
        console.error('❌ Archive list failed:', err.message);
        res.status(500).json({ error: 'Could not list the term books' });
    }
});

/**
 * GET /api/archive/:name/download
 * Sends one saved term book as a PDF download.
 */
router.get('/:name/download', async (req, res) => {
    const { name } = req.params;
    // Only names this app created, so nothing else in storage can be requested
    if (!BOOK_NAME.test(name)) {
        return res.status(400).json({ error: 'Invalid archive name' });
    }

    try {
        const stat = await minioClient.statObject(ARCHIVE_BUCKET, name);
        const stream = await minioClient.getObject(ARCHIVE_BUCKET, name);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        stream.on('error', (err) => {
            console.error('❌ Archive download stream failed:', err.message);
            res.destroy(err);
        });
        stream.pipe(res);
    } catch (err) {
        if (err.code === 'NotFound' || err.code === 'NoSuchKey') {
            return res.status(404).json({ error: 'Term book not found' });
        }
        console.error('❌ Archive download failed:', err.message);
        res.status(500).json({ error: 'Could not download the term book' });
    }
});

module.exports = router;
