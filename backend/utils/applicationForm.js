const { isCountryCode } = require('./countries');

// Checks the institutions and fulfilled courses of a submitted application (Group 4).
// Every problem is collected with its field path (e.g. 'fulfilled_courses[1].credits'),
// so the form can show all of them at once, under the right fields. The browser runs the
// same rules first, for convenience only.

const LIMITS = {
    institutions: 10,
    fulfilledCourses: 20,
    targetCourses: 1,   // one PTE course per application (covered by one or more fulfilled courses)
    institutionName: 200,
    courseName: 200,
    courseCode: 50,
    grade: 20,
    creditSystemOther: 50,
};

// --- Notes to the reviewer (application note and "add missing info" note) ---
// Counted the same way in the browser (frontend/src/applicationForm.js): after normalising
// (an "á" typed as "a" + accent is one character), in Unicode characters (an emoji is one,
// not two as JavaScript's .length would count). check:form-rules compares both.
const NOTE_MAX = 2000;
const normalizeNote = (text) => (typeof text === 'string' ? text.normalize('NFC') : '');
const noteLength = (text) => [...normalizeNote(text)].length;
// null = fine; otherwise { code, message, params }
const checkNote = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return { code: 'INVALID_NOTE', message: 'The note must be text' };
    if (noteLength(value) > NOTE_MAX) return { code: 'NOTE_TOO_LONG', message: `The note can be at most ${NOTE_MAX} characters`, params: { max: NOTE_MAX } };
    return null;
};

// Credit systems and the most credits one course may have in each (no conversion: the reviewer judges)
const CREDIT_MAX = { ECTS: 60, US_CREDIT_HOURS: 30, UK_CATS: 120, OTHER: 120 };
const MOST_GENEROUS_MAX = Math.max(...Object.values(CREDIT_MAX));

// Trimmed text if it is a string within the length limits, otherwise null
const cleanText = (value, max, { required = true } = {}) => {
    if (value === undefined || value === null || value === '') return required ? null : '';
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.length === 0) return required ? null : '';
    return text.length <= max ? text : null;
};

// "TU Berlin" and " tu  berlin " in the same country are the same institution
const institutionKey = (name, country) => `${name.toLowerCase().replace(/\s+/g, ' ')}|${country}`;

// A real number, more than 0, in steps of 0.5, at most `max`
const isValidCredits = (value, max) => typeof value === 'number' && Number.isFinite(value)
    && value > 0 && value <= max && Number.isInteger(value * 2);

/**
 * @returns {{ errors: Array, institutions: Array, fulfilledCourses: Array, targetCourseIds: number[] }}
 *   errors: [{ field, code, message, params? }] in form order (empty = all fine).
 *   The other values are the cleaned data to store, built from checked fields only.
 */
const validateApplicationForm = (body) => {
    const errors = [];
    const add = (field, code, message, params) => errors.push(params ? { field, code, message, params } : { field, code, message });

    // --- Institutions ---
    const rawInstitutions = body.institutions;
    const institutions = [];
    if (!Array.isArray(rawInstitutions) || rawInstitutions.length < 1 || rawInstitutions.length > LIMITS.institutions) {
        add('institutions', 'INVALID_INSTITUTIONS', `Add between 1 and ${LIMITS.institutions} institutions`, { max: LIMITS.institutions });
    } else {
        const seen = new Set();
        rawInstitutions.forEach((raw, i) => {
            const item = raw && typeof raw === 'object' ? raw : {};
            const path = `institutions[${i}]`;
            const name = cleanText(item.name, LIMITS.institutionName);
            const country = isCountryCode(item.country) ? item.country : null;
            const gradingFile = typeof item.grading_file === 'string' && item.grading_file ? item.grading_file : null;

            if (name === null) add(`${path}.name`, 'INVALID_INSTITUTION_NAME', `Enter the institution's name (up to ${LIMITS.institutionName} characters)`, { max: LIMITS.institutionName });
            if (country === null) add(`${path}.country`, 'INVALID_COUNTRY', 'Choose a country');
            if (gradingFile === null) add(`${path}.grading_file`, 'GRADING_FILE_MISSING', 'Upload the grading system document for this institution');
            if (name !== null && country !== null) {
                const key = institutionKey(name, country);
                if (seen.has(key)) add(`${path}.name`, 'DUPLICATE_INSTITUTION', 'This institution is already in the list');
                seen.add(key);
            }
            institutions.push({ name, country, grading_file: gradingFile });
        });
    }

    // --- Fulfilled courses ---
    const rawCourses = body.fulfilled_courses;
    const fulfilledCourses = [];
    const usedInstitutions = new Set();
    const coursesListValid = Array.isArray(rawCourses) && rawCourses.length >= 1 && rawCourses.length <= LIMITS.fulfilledCourses;
    if (!coursesListValid) {
        add('fulfilled_courses', 'INVALID_FULFILLED_COURSES', `Add between 1 and ${LIMITS.fulfilledCourses} completed courses`, { max: LIMITS.fulfilledCourses });
    } else {
        rawCourses.forEach((raw, r) => {
            const item = raw && typeof raw === 'object' ? raw : {};
            const path = `fulfilled_courses[${r}]`;

            const institution = Number.isInteger(item.institution) && item.institution >= 0 && item.institution < institutions.length
                ? item.institution : null;
            if (institution === null) add(`${path}.institution`, 'INVALID_INSTITUTION_CHOICE', 'Choose the institution where you completed this course');
            else usedInstitutions.add(institution);

            const courseName = cleanText(item.course_name, LIMITS.courseName);
            if (courseName === null) add(`${path}.course_name`, 'INVALID_COURSE_NAME', `Enter the course name (up to ${LIMITS.courseName} characters)`, { max: LIMITS.courseName });

            const courseCode = cleanText(item.course_code, LIMITS.courseCode, { required: false });
            if (courseCode === null) add(`${path}.course_code`, 'INVALID_COURSE_CODE', `The course code can be at most ${LIMITS.courseCode} characters`, { max: LIMITS.courseCode });

            const grade = cleanText(item.grade, LIMITS.grade);
            if (grade === null) add(`${path}.grade`, 'INVALID_GRADE', `Enter the grade (up to ${LIMITS.grade} characters)`, { max: LIMITS.grade });

            const creditSystem = Object.prototype.hasOwnProperty.call(CREDIT_MAX, item.credit_system) ? item.credit_system : null;
            if (creditSystem === null) add(`${path}.credit_system`, 'INVALID_CREDIT_SYSTEM', 'Choose the credit system');

            let creditSystemOther = null;
            if (creditSystem === 'OTHER') {
                creditSystemOther = cleanText(item.credit_system_other, LIMITS.creditSystemOther);
                if (creditSystemOther === null) add(`${path}.credit_system_other`, 'INVALID_CREDIT_SYSTEM_OTHER', `Name the credit system (up to ${LIMITS.creditSystemOther} characters)`, { max: LIMITS.creditSystemOther });
            }

            const maxCredits = creditSystem ? CREDIT_MAX[creditSystem] : MOST_GENEROUS_MAX;
            if (!isValidCredits(item.credits, maxCredits)) {
                add(`${path}.credits`, 'INVALID_CREDITS', `Credits must be more than 0 and at most ${maxCredits}, in steps of 0.5`, { max: maxCredits });
            }

            // The transcript (evidence) is required; the syllabus only when the syllabus rule applies
            const file = typeof item.file === 'string' && item.file ? item.file : null;
            if (file === null) add(`${path}.file`, 'EVIDENCE_MISSING', 'No transcript uploaded for this course');
            const syllabusFile = typeof item.syllabus_file === 'string' && item.syllabus_file ? item.syllabus_file : null;

            // Stored row: the keys the reviewer screen, admin screen and term book already read,
            // plus the Group 4 fields. Nothing else from the request is kept.
            fulfilledCourses.push({
                course_name: courseName,
                course_code: courseCode || '',
                credits: item.credits,
                grade,
                file,
                syllabus_file: syllabusFile,
                institution,
                credit_system: creditSystem,
                credit_system_other: creditSystemOther,
            });
        });
    }

    // An institution no course uses would only carry an unused grading file
    // (only judged when the course list itself is valid, to avoid follow-on errors)
    institutions.forEach((inst, i) => {
        if (coursesListValid && !usedInstitutions.has(i)) {
            add(`institutions[${i}].name`, 'INSTITUTION_UNUSED', 'No course is linked to this institution');
        }
    });

    // --- Note to the reviewer (optional) ---
    const noteProblem = checkNote(body.student_note);
    if (noteProblem) add('student_note', noteProblem.code, noteProblem.message, noteProblem.params);

    // --- Target courses (their programme is checked against the database afterwards) ---
    const rawTargets = body.target_course_ids;
    let targetCourseIds = null;
    if (Array.isArray(rawTargets) && rawTargets.every((id) => Number.isInteger(id) && id > 0)) {
        const ids = [...new Set(rawTargets)];
        if (ids.length >= 1 && ids.length <= LIMITS.targetCourses) targetCourseIds = ids;
    }
    if (!targetCourseIds) {
        add('target_course_ids', 'INVALID_TARGET_COURSES', 'Choose one PTE course');
    }

    // Keep errors in form order: institutions, course rows, target course, note
    const order = (field) => (field.startsWith('institutions') ? 0 : field.startsWith('fulfilled_courses') ? 1 : field === 'target_course_ids' ? 2 : 3);
    errors.sort((a, b) => order(a.field) - order(b.field));

    return { errors, institutions, fulfilledCourses, targetCourseIds };
};

// Every file the application refers to, with its field path (for the ownership check)
const filesWithPaths = (institutions, fulfilledCourses) => [
    ...institutions.map((inst, i) => ({ field: `institutions[${i}].grading_file`, file: inst.grading_file })),
    ...fulfilledCourses.map((course, r) => ({ field: `fulfilled_courses[${r}].file`, file: course.file })),
    ...fulfilledCourses.flatMap((course, r) => (course.syllabus_file ? [{ field: `fulfilled_courses[${r}].syllabus_file`, file: course.syllabus_file }] : [])),
];

// --- Syllabus rule: when the reviewer needs a syllabus for every fulfilled course ---
// The browser shows the same reasons (frontend/src/applicationForm.js); check:form-rules compares them.
const SYLLABUS_REASON_TEXT = {
    CREDIT_GAP: 'credits are lower than those of the target PTE course',
    CREDIT_SYSTEMS: 'credits cannot be compared automatically (different credit systems)',
    COMBINED_COURSES: 'more than one completed course is combined for this PTE course',
};

/**
 * @param rows        checked fulfilled courses ({ credits, credit_system })
 * @param targetCredits credits of the target PTE course (from the database)
 * @returns reason codes, in a fixed order; empty = no syllabus needed
 */
const syllabusReasons = (rows, targetCredits) => {
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

// The English note for the reviewer and the term book ('' when no syllabus is needed)
const syllabusNote = (reasons) => (reasons.length
    ? `Syllabus required: ${reasons.map((code) => SYLLABUS_REASON_TEXT[code]).join('; ')}.`
    : '');

// One error per fulfilled course without a syllabus
const missingSyllabi = (rows) => rows.flatMap((row, r) => (row.syllabus_file ? [] : [{
    field: `fulfilled_courses[${r}].syllabus_file`, code: 'SYLLABUS_REQUIRED', message: 'Upload the syllabus for this course',
}]));

// Every status an application can have. "withdrawn" is set only by the student (Group 8).
const ALL_STATUSES = ['pending', 'needs_info', 'approved', 'rejected', 'withdrawn'];

// --- One active application per PTE course (Group 6) ---
// While an application has one of these statuses, the student can't apply for the same PTE course
// again. Every other status (rejected, and a future "withdrawn") allows a new application.
// The database enforces the same rule (migration 005, applications_one_active_per_course).
const BLOCKING_STATUSES = ['pending', 'needs_info', 'approved'];

// Course codes are compared ignoring case and spaces ("cs 202" = "CS202"), like the database index
const normalizeCourseCode = (code) => String(code || '').replace(/\s/g, '').toUpperCase();

module.exports = {
    validateApplicationForm, filesWithPaths, syllabusReasons, syllabusNote, missingSyllabi,
    ALL_STATUSES, BLOCKING_STATUSES, normalizeCourseCode, NOTE_MAX, normalizeNote, noteLength, checkNote, CREDIT_MAX, LIMITS,
};
