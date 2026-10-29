// Plain helpers for the application form's institutions and fulfilled courses (no React),
// so the rules can be tested on their own. The server checks everything again.

export const CREDIT_SYSTEMS = ['ECTS', 'US_CREDIT_HOURS', 'UK_CATS', 'OTHER'];

// Stable internal keys: rows point to an institution by key while editing, so removing
// an institution can never shift rows onto another one. Keys become positions only at submit.
let lastKey = 0;
const nextKey = (prefix) => `${prefix}-${Date.now()}-${++lastKey}`;

export const newInstitution = () => ({ key: nextKey('inst'), name: '', country: '', grading_file: null });

export const newCourseRow = () => ({
    id: nextKey('row'),
    institutionKey: '',
    course_name: '',
    course_code: '',
    credits: '',
    credit_system: '',   // chosen deliberately by the student; empty is refused (INVALID_CREDIT_SYSTEM)
    credit_system_other: '',
    grade: '',
    file: null,            // the transcript, with this course's line highlighted
    syllabus_file: null,   // only needed when the syllabus rule applies
});

// Text from a number input -> a real number for the server ('' or nonsense -> null, which it refuses)
export const toCredits = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value ?? '').trim();
    if (text === '') return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
};

// Credits can only be compared with the PTE target courses (ECTS) when every row is ECTS
export const allEcts = (rows) => rows.length > 0 && rows.every((row) => row.credit_system === 'ECTS');

// Whether a row holds anything worth confirming before removal
export const rowHasContent = (row) => Boolean(
    row.file || row.syllabus_file || row.institutionKey
    || ['course_name', 'course_code', 'credits', 'credit_system', 'grade', 'credit_system_other'].some((field) => String(row[field] ?? '').trim() !== '')
);

// How many course rows use an institution (asked before removing it)
export const rowsUsingInstitution = (rows, key) => rows.filter((row) => row.institutionKey === key).length;

// Removing an institution: its rows keep their other fields, but their institution choice is cleared
export const removeInstitution = (institutions, rows, key) => ({
    institutions: institutions.filter((inst) => inst.key !== key),
    rows: rows.map((row) => (row.institutionKey === key ? { ...row, institutionKey: '' } : row)),
});

// Country codes -> [{ code, name }] in the given language, sorted the way that language sorts
export const countryOptions = (codes, language) => {
    let names;
    try { names = new Intl.DisplayNames([language], { type: 'region' }); } catch { names = null; }
    return codes
        .map((code) => ({ code, name: (names && names.of(code)) || code }))
        .sort((a, b) => a.name.localeCompare(b.name, language));
};

/**
 * The submit body: internal keys -> positions, credits -> numbers, only the fields the server reads.
 * Also returns the maps back from positions to keys/ids, to place server errors under the right
 * institution or row (e.g. 'fulfilled_courses[1].credits' -> row id).
 */
export const buildSubmission = (institutions, rows) => {
    const positionOfKey = new Map(institutions.map((inst, i) => [inst.key, i]));
    return {
        institutions: institutions.map((inst) => ({
            name: inst.name,
            country: inst.country,
            grading_file: inst.grading_file,
        })),
        fulfilled_courses: rows.map((row) => ({
            institution: positionOfKey.has(row.institutionKey) ? positionOfKey.get(row.institutionKey) : null,
            course_name: row.course_name,
            course_code: row.course_code,
            credits: toCredits(row.credits),
            credit_system: row.credit_system,
            ...(row.credit_system === 'OTHER' ? { credit_system_other: row.credit_system_other } : {}),
            grade: row.grade,
            file: row.file,
            syllabus_file: row.syllabus_file || null,
        })),
        institutionKeyAt: institutions.map((inst) => inst.key),
        rowIdAt: rows.map((row) => row.id),
    };
};

// ---------------------------------------------------------------------------------------------
// Browser-side checks. The SAME rules, limits and codes as the server's validator
// (backend/utils/applicationForm.js), run on the same body that is sent. Only for convenience:
// the server checks everything again. A test runs both on the same inputs and compares them.

// Notes to the reviewer: counted like the server (backend/utils/applicationForm.js), after
// normalising (an "á" typed as "a" + accent is one character), in Unicode characters (an emoji is
// one, not two as .length would count). check:form-rules compares both.
export const NOTE_MAX = 2000;
export const normalizeNote = (text) => (typeof text === 'string' ? text.normalize('NFC') : '');
export const noteLength = (text) => [...normalizeNote(text)].length;
export const checkNote = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return { code: 'INVALID_NOTE' };
    if (noteLength(value) > NOTE_MAX) return { code: 'NOTE_TOO_LONG', params: { max: NOTE_MAX } };
    return null;
};

export const LIMITS = { institutions: 10, fulfilledCourses: 20, targetCourses: 1, institutionName: 200, courseName: 200, courseCode: 50, grade: 20, creditSystemOther: 50 };
export const CREDIT_MAX = { ECTS: 60, US_CREDIT_HOURS: 30, UK_CATS: 120, OTHER: 120 };
const MOST_GENEROUS_MAX = Math.max(...Object.values(CREDIT_MAX));

const cleanText = (value, max, { required = true } = {}) => {
    if (value === undefined || value === null || value === '') return required ? null : '';
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.length === 0) return required ? null : '';
    return text.length <= max ? text : null;
};
const institutionKeyOf = (name, country) => `${name.toLowerCase().replace(/\s+/g, ' ')}|${country}`;
const isValidCredits = (value, max) => typeof value === 'number' && Number.isFinite(value)
    && value > 0 && value <= max && Number.isInteger(value * 2);

/**
 * Checks a submit body ({ institutions, fulfilled_courses, target_course_ids }).
 * @param isCountryCode function telling whether a country code is in the list from /api/countries
 * @returns [{ field, code, params? }] in form order, with the server's field paths
 */
export const validateSubmission = (body, isCountryCode) => {
    const errors = [];
    const add = (field, code, params) => errors.push(params ? { field, code, params } : { field, code });

    const institutions = body.institutions;
    const institutionCount = Array.isArray(institutions) ? institutions.length : 0;
    if (!Array.isArray(institutions) || institutionCount < 1 || institutionCount > LIMITS.institutions) {
        add('institutions', 'INVALID_INSTITUTIONS', { max: LIMITS.institutions });
    } else {
        const seen = new Set();
        institutions.forEach((raw, i) => {
            const item = raw && typeof raw === 'object' ? raw : {};
            const path = `institutions[${i}]`;
            const name = cleanText(item.name, LIMITS.institutionName);
            const country = isCountryCode(item.country) ? item.country : null;
            if (name === null) add(`${path}.name`, 'INVALID_INSTITUTION_NAME', { max: LIMITS.institutionName });
            if (country === null) add(`${path}.country`, 'INVALID_COUNTRY');
            if (!(typeof item.grading_file === 'string' && item.grading_file)) add(`${path}.grading_file`, 'GRADING_FILE_MISSING');
            if (name !== null && country !== null) {
                const key = institutionKeyOf(name, country);
                if (seen.has(key)) add(`${path}.name`, 'DUPLICATE_INSTITUTION');
                seen.add(key);
            }
        });
    }

    const rows = body.fulfilled_courses;
    const rowsValid = Array.isArray(rows) && rows.length >= 1 && rows.length <= LIMITS.fulfilledCourses;
    const used = new Set();
    if (!rowsValid) {
        add('fulfilled_courses', 'INVALID_FULFILLED_COURSES', { max: LIMITS.fulfilledCourses });
    } else {
        const validInstitutionCount = Array.isArray(institutions) && institutionCount >= 1 && institutionCount <= LIMITS.institutions ? institutionCount : 0;
        rows.forEach((raw, r) => {
            const item = raw && typeof raw === 'object' ? raw : {};
            const path = `fulfilled_courses[${r}]`;
            if (Number.isInteger(item.institution) && item.institution >= 0 && item.institution < validInstitutionCount) used.add(item.institution);
            else add(`${path}.institution`, 'INVALID_INSTITUTION_CHOICE');
            if (cleanText(item.course_name, LIMITS.courseName) === null) add(`${path}.course_name`, 'INVALID_COURSE_NAME', { max: LIMITS.courseName });
            if (cleanText(item.course_code, LIMITS.courseCode, { required: false }) === null) add(`${path}.course_code`, 'INVALID_COURSE_CODE', { max: LIMITS.courseCode });
            if (cleanText(item.grade, LIMITS.grade) === null) add(`${path}.grade`, 'INVALID_GRADE', { max: LIMITS.grade });
            const system = Object.prototype.hasOwnProperty.call(CREDIT_MAX, item.credit_system) ? item.credit_system : null;
            if (system === null) add(`${path}.credit_system`, 'INVALID_CREDIT_SYSTEM');
            if (system === 'OTHER' && cleanText(item.credit_system_other, LIMITS.creditSystemOther) === null) {
                add(`${path}.credit_system_other`, 'INVALID_CREDIT_SYSTEM_OTHER', { max: LIMITS.creditSystemOther });
            }
            const max = system ? CREDIT_MAX[system] : MOST_GENEROUS_MAX;
            if (!isValidCredits(item.credits, max)) add(`${path}.credits`, 'INVALID_CREDITS', { max });
            if (!(typeof item.file === 'string' && item.file)) add(`${path}.file`, 'EVIDENCE_MISSING');
        });
    }
    if (Array.isArray(institutions) && institutionCount >= 1 && institutionCount <= LIMITS.institutions) {
        institutions.forEach((inst, i) => {
            if (rowsValid && !used.has(i)) add(`institutions[${i}].name`, 'INSTITUTION_UNUSED');
        });
    }

    const noteProblem = checkNote(body.student_note);
    if (noteProblem) add('student_note', noteProblem.code, noteProblem.params);

    const targets = body.target_course_ids;
    const ids = Array.isArray(targets) && targets.every((id) => Number.isInteger(id) && id > 0) ? [...new Set(targets)] : null;
    if (!ids || ids.length < 1 || ids.length > LIMITS.targetCourses) add('target_course_ids', 'INVALID_TARGET_COURSES');

    const order = (field) => (field.startsWith('institutions') ? 0 : field.startsWith('fulfilled_courses') ? 1 : field === 'target_course_ids' ? 2 : 3);
    return errors.sort((a, b) => order(a.field) - order(b.field));
};

/**
 * A server field path -> the form's own key for that field, using the maps from buildSubmission:
 *   'institutions[1].country'      -> 'inst:<key>:country'
 *   'fulfilled_courses[0].credits' -> 'row:<id>:credits'
 *   'target_course_ids', 'institutions', 'fulfilled_courses' stay as they are.
 * Returns null for a path the form doesn't know (shown in the message under Submit instead).
 */
const INSTITUTION_FIELDS = ['name', 'country', 'grading_file'];
const ROW_FIELDS = ['institution', 'course_name', 'course_code', 'credits', 'credit_system', 'credit_system_other', 'grade', 'file', 'syllabus_file'];
export const formKeyForPath = (path, map) => {
    if (['target_course_ids', 'institutions', 'fulfilled_courses', 'student_note', 'student_resubmit_note'].includes(path)) return path;
    let match = /^institutions\[(\d+)\]\.(\w+)$/.exec(path);
    if (match && INSTITUTION_FIELDS.includes(match[2]) && map.institutionKeyAt[match[1]]) return `inst:${map.institutionKeyAt[match[1]]}:${match[2]}`;
    match = /^fulfilled_courses\[(\d+)\]\.(\w+)$/.exec(path);
    if (match && ROW_FIELDS.includes(match[2]) && map.rowIdAt[match[1]]) return `row:${map.rowIdAt[match[1]]}:${match[2]}`;
    return null;
};

// ---------------------------------------------------------------------------------------------
// Syllabus rule: the same reasons as the server (backend/utils/applicationForm.js), in the same
// order. When any applies, every fulfilled course needs its syllabus.

/**
 * @param rows          fulfilled courses with numeric credits and a credit system (as sent)
 * @param targetCredits credits of the chosen PTE course
 * @returns reason codes: CREDIT_GAP, CREDIT_SYSTEMS, COMBINED_COURSES (empty = no syllabus needed)
 */
export const syllabusReasons = (rows, targetCredits) => {
    const reasons = [];
    if (rows.every((row) => row.credit_system === 'ECTS')) {
        const total = rows.reduce((sum, row) => sum + row.credits, 0);
        if (total < targetCredits) reasons.push('CREDIT_GAP');
    } else {
        reasons.push('CREDIT_SYSTEMS');
    }
    if (rows.length > 1) reasons.push('COMBINED_COURSES');
    return reasons;
};

// One error per fulfilled course without a syllabus (server paths)
export const missingSyllabi = (rows) => rows.flatMap((row, r) => (row.syllabus_file ? [] : [{ field: `fulfilled_courses[${r}].syllabus_file`, code: 'SYLLABUS_REQUIRED' }]));

// While the form is being filled in: the reasons, or null while it can't be judged yet
// (no PTE course chosen, or a row without a credit system or valid credits)
export const syllabusReasonsWhileEditing = (rows, targetCourse) => {
    if (!targetCourse || rows.length === 0) return null;
    const sent = rows.map((row) => ({ credits: toCredits(row.credits), credit_system: row.credit_system }));
    if (sent.some((row) => !row.credit_system || row.credits === null)) return null;
    return syllabusReasons(sent, Number(targetCourse.credits));
};

// ---------------------------------------------------------------------------------------------
// One active application per PTE course: the same statuses and code comparison as the server
// (backend/utils/applicationForm.js). Every other status (rejected, a future "withdrawn") allows a new one.
export const BLOCKING_STATUSES = ['pending', 'needs_info', 'approved'];
export const normalizeCourseCode = (code) => String(code || '').replace(/\s/g, '').toUpperCase();

/**
 * PTE courses the student can't apply for right now: { normalisedCode: status }.
 * @param applications the student's own applications (from applications/mine)
 */
export const blockedCourseCodes = (applications) => {
    const blocked = {};
    for (const app of applications) {
        if (!BLOCKING_STATUSES.includes(app.status)) continue;
        const code = normalizeCourseCode(app.target_course_code || app.target_courses?.[0]?.course_code);
        // "approved" is the stronger reason to show
        if (code && blocked[code] !== 'approved') blocked[code] = app.status;
    }
    return blocked;
};
