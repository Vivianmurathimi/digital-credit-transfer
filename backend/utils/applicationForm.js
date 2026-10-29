const { isCountryCode } = require('./countries');

// Checks the institutions and fulfilled courses of a submitted application (Group 4).
// Every problem is collected with its field path (e.g. 'fulfilled_courses[1].credits'),
// so the form can show all of them at once, under the right fields. The browser runs the
// same rules first, for convenience only.

const LIMITS = {
    institutions: 10,
    fulfilledCourses: 20,
    targetCourses: 10,
    institutionName: 200,
    courseName: 200,
    courseCode: 50,
    grade: 20,
    creditSystemOther: 50,
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

            const file = typeof item.file === 'string' && item.file ? item.file : null;
            if (file === null) add(`${path}.file`, 'EVIDENCE_MISSING', 'No evidence uploaded for this course');

            // Stored row: the keys the reviewer screen, admin screen and term book already read,
            // plus the Group 4 fields. Nothing else from the request is kept.
            fulfilledCourses.push({
                course_name: courseName,
                course_code: courseCode || '',
                credits: item.credits,
                grade,
                file,
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

    // --- Target courses (their programme is checked against the database afterwards) ---
    const rawTargets = body.target_course_ids;
    let targetCourseIds = null;
    if (Array.isArray(rawTargets) && rawTargets.every((id) => Number.isInteger(id) && id > 0)) {
        const ids = [...new Set(rawTargets)];
        if (ids.length >= 1 && ids.length <= LIMITS.targetCourses) targetCourseIds = ids;
    }
    if (!targetCourseIds) {
        add('target_course_ids', 'INVALID_TARGET_COURSES', `Choose between 1 and ${LIMITS.targetCourses} target courses`, { max: LIMITS.targetCourses });
    }

    // Keep errors in form order: institutions, then course rows, then target courses
    const order = (field) => (field.startsWith('institutions') ? 0 : field.startsWith('fulfilled_courses') ? 1 : 2);
    errors.sort((a, b) => order(a.field) - order(b.field));

    return { errors, institutions, fulfilledCourses, targetCourseIds };
};

// Every file the application refers to, with its field path (for the ownership check)
const filesWithPaths = (institutions, fulfilledCourses) => [
    ...institutions.map((inst, i) => ({ field: `institutions[${i}].grading_file`, file: inst.grading_file })),
    ...fulfilledCourses.map((course, r) => ({ field: `fulfilled_courses[${r}].file`, file: course.file })),
];

module.exports = { validateApplicationForm, filesWithPaths, CREDIT_MAX, LIMITS };
