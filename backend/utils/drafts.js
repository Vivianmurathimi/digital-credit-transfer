const { LIMITS } = require('./applicationForm');

// Drafts of the application form (Group 7). The browser decides what is in `data`
// (frontend/src/applicationForm.js, draftFromForm); the server only stores it for its owner,
// limits its size and, when reading it back, removes files that aren't the student's own.

const DRAFT_MAX_KB = 200;
const DRAFT_MAX_BYTES = DRAFT_MAX_KB * 1024;
const MAX_VERSION = 1000;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * Checks a draft before it is saved.
 * @returns {null | { status, code, field, message, params? }} null = fine
 */
const checkDraft = (version, data) => {
    if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
        return { status: 400, code: 'INVALID_DRAFT', field: 'version', message: 'The draft has no valid format version' };
    }
    if (!isPlainObject(data)) return { status: 400, code: 'INVALID_DRAFT', field: 'data', message: 'The draft must be an object' };
    // The same limits as a submit, so reading a draft back never checks more files than a real form has
    if (listOf(data.institutions).length > LIMITS.institutions || listOf(data.rows).length > LIMITS.fulfilledCourses) {
        return { status: 400, code: 'INVALID_DRAFT', field: 'data', message: 'The draft has more institutions or courses than a form allows' };
    }
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > DRAFT_MAX_BYTES) {
        return { status: 413, code: 'DRAFT_TOO_LARGE', field: 'data', message: 'The draft is too large to save', params: { max: DRAFT_MAX_KB } };
    }
    return null;
};

// Where a draft names uploaded files: each institution's grading document, each row's transcript and syllabus
const FILE_PLACES = [
    ['institutions', ['grading_file']],
    ['rows', ['file', 'syllabus_file']],
];

// Every file name the draft mentions (only text values count)
const draftFileNames = (data) => {
    const names = new Set();
    for (const [list, fields] of FILE_PLACES) {
        for (const item of listOf(data[list])) {
            if (!isPlainObject(item)) continue;
            for (const field of fields) if (typeof item[field] === 'string' && item[field]) names.add(item[field]);
        }
    }
    return names;
};

/**
 * The draft with every file that isn't in `keep` set to null (also non-text values).
 * @returns {{ data, dropped: number }} dropped = how many places lost their file
 */
const keepOnlyFiles = (data, keep) => {
    let dropped = 0;
    const copy = { ...data };
    for (const [list, fields] of FILE_PLACES) {
        if (!Array.isArray(data[list])) continue;
        copy[list] = data[list].map((item) => {
            if (!isPlainObject(item)) return item;
            const cleaned = { ...item };
            for (const field of fields) {
                if (cleaned[field] == null || cleaned[field] === '') continue;
                if (typeof cleaned[field] !== 'string' || !keep.has(cleaned[field])) {
                    cleaned[field] = null;
                    dropped += 1;
                }
            }
            return cleaned;
        });
    }
    return { data: copy, dropped };
};

module.exports = { DRAFT_MAX_KB, DRAFT_MAX_BYTES, checkDraft, draftFileNames, keepOnlyFiles };
