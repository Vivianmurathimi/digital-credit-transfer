const minioClient = require('../minio');
const { decodeFromMetadata } = require('./fileRules');

const EVIDENCE_BUCKET = 'transcripts';

/**
 * Who uploaded an evidence file (the uploads route tags every file with the uploader's id).
 * @returns {Promise<{ exists: boolean, ownerId: number | null, contentType?: string, originalName?: string | null }>}
 */
const getFileOwner = async (fileName) => {
    try {
        const stat = await minioClient.statObject(EVIDENCE_BUCKET, fileName);
        // MinIO returns user metadata without the x-amz-meta- prefix; accept both forms
        const raw = stat.metaData['uploader-id'] ?? stat.metaData['x-amz-meta-uploader-id'];
        const ownerId = raw ? parseInt(raw, 10) : null;
        // The name the student chose (files from before Group 5 have none)
        const originalName = decodeFromMetadata(stat.metaData['original-name'] ?? stat.metaData['x-amz-meta-original-name']);
        return { exists: true, ownerId: Number.isNaN(ownerId) ? null : ownerId, contentType: stat.metaData['content-type'], originalName };
    } catch (err) {
        if (err.code === 'NotFound' || err.code === 'NoSuchKey') return { exists: false, ownerId: null };
        throw err;
    }
};

/**
 * Checks that every file name belongs to this user. Used on submit and resubmit,
 * so a student can never attach another student's evidence.
 * @returns {Promise<string[]>} the file names that are missing or owned by someone else (empty = all fine)
 */
const findFilesNotOwnedBy = async (fileNames, userId) => {
    const notOwned = [];
    for (const fileName of fileNames) {
        const { exists, ownerId } = await getFileOwner(fileName);
        if (!exists || ownerId !== userId) notOwned.push(fileName);
    }
    return notOwned;
};

// "a.png,b.png," -> ['a.png', 'b.png']
const splitFileList = (value) =>
    String(value || '').split(',').map((name) => name.trim()).filter(Boolean);

module.exports = { getFileOwner, findFilesNotOwnedBy, splitFileList };
