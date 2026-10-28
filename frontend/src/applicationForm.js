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
    credit_system: 'ECTS',
    credit_system_other: '',
    grade: '',
    file: null,
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
        })),
        institutionKeyAt: institutions.map((inst) => inst.key),
        rowIdAt: rows.map((row) => row.id),
    };
};
