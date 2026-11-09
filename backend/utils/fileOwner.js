const minioClient = require('../minio');
const { decodeFromMetadata } = require('./fileRules');

const { EVIDENCE_BUCKET } = require('../config/buckets');

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

/**
 * Whether an application of this programme refers to the file (reviewer Group 2: a reviewer may
 * open only their own programme's files). Every place an application can name a file:
 *   1. fulfilled_courses_json[*].file           the transcript of each fulfilled course
 *   2. fulfilled_courses_json[*].syllabus_file  its syllabus
 *   3. institutions[*].grading_file             each institution's grading system
 *   4. supplemental_files                       the old comma-separated list of reply files
 *   5. application_events.files                 files the student added with a reply
 * @param {{ query: Function }} db
 * @returns {Promise<boolean>}
 */
const isFileInProgramme = async (db, fileName, programmeId) => findApplicationWithFile(db, fileName, programmeId);

/**
 * Whether any submitted application (any status, any semester, any programme) uses the file
 * (reviewer group L3). Such a file can't be deleted, so past semesters keep their evidence.
 * Files that are only in a draft are not counted.
 */
const isFileInUse = (db, fileName) => findApplicationWithFile(db, fileName, null);

// programmeId null: every programme
const findApplicationWithFile = async (db, fileName, programmeId) => {
    const { rows } = await db.query(
        `SELECT 1 FROM applications a
         WHERE ($2::int IS NULL OR a.programme_id = $2) AND (
               EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.fulfilled_courses_json) = 'array' THEN a.fulfilled_courses_json ELSE '[]'::jsonb END) c
                       WHERE c->>'file' = $1 OR c->>'syllabus_file' = $1)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.institutions) = 'array' THEN a.institutions ELSE '[]'::jsonb END) i
                       WHERE i->>'grading_file' = $1)
            OR $1 = ANY (string_to_array(replace(COALESCE(a.supplemental_files, ''), ' ', ''), ','))
            OR EXISTS (SELECT 1 FROM application_events e WHERE e.application_id = a.id AND $1 = ANY (e.files))
         )
         LIMIT 1`,
        [fileName, programmeId]
    );
    return rows.length > 0;
};

// "a.png,b.png," -> ['a.png', 'b.png']
const splitFileList = (value) =>
    String(value || '').split(',').map((name) => name.trim()).filter(Boolean);

module.exports = { getFileOwner, findFilesNotOwnedBy, isFileInProgramme, isFileInUse, splitFileList };
