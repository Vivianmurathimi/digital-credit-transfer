const path = require('path');
const minioClient = require('../minio');

const EVIDENCE_BUCKET = 'transcripts';
// pdfkit can only embed PNG and JPEG images
const EMBEDDABLE = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg' };
const MAX_BYTES = 15 * 1024 * 1024; // skip anything unexpectedly large

const streamToBuffer = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
            stream.destroy();
            reject(new Error(`larger than ${MAX_BYTES / 1024 / 1024} MB`));
            return;
        }
        chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
});

/**
 * Loads one evidence file from MinIO, one at a time so the whole term never sits in memory.
 * Never throws.
 *
 * @returns {Promise<{ embeddable: true, buffer: Buffer, format: string }
 *                  | { embeddable: false, reason: 'not_image' | 'missing' | 'error' }>}
 */
const fetchEvidence = async (fileName) => {
    const format = EMBEDDABLE[path.extname(fileName || '').toLowerCase()];
    if (!format) return { embeddable: false, reason: 'not_image' };

    try {
        const stream = await minioClient.getObject(EVIDENCE_BUCKET, fileName);
        const buffer = await streamToBuffer(stream);
        return { embeddable: true, buffer, format };
    } catch (err) {
        const missing = err.code === 'NoSuchKey' || err.code === 'NotFound';
        if (!missing) console.error(`❌ Could not load evidence "${fileName}":`, err.message);
        return { embeddable: false, reason: missing ? 'missing' : 'error' };
    }
};

module.exports = fetchEvidence;
