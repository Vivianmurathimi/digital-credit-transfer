// The reviewer's decisions (reviewer Group 6), in one place: which status changes are allowed and
// what each one needs. Used by PUT /api/applications/:id/status for everyone who can decide
// (reviewers, and the superadmin, also while impersonating a reviewer).
//
// Allowed: pending -> approved / rejected / needs_info. Nothing else:
// - needs_info -> pending happens only through the student's reply (resubmit route)
// - approved, rejected and withdrawn are final here (admin overrides come in the admin round)

const { NOTE_MAX, normalizeNote, noteLength } = require('./applicationForm');

const DECIDABLE_STATUS = 'pending';
const DECISIONS = ['approved', 'rejected', 'needs_info'];
const FINAL_GRADES = [2, 3, 4, 5];

// Why a change from this status is refused (409), when the application isn't pending any more
const REFUSED_FROM = {
    approved: ['ALREADY_DECIDED', 'This application has already been decided'],
    rejected: ['ALREADY_DECIDED', 'This application has already been decided'],
    withdrawn: ['APPLICATION_WITHDRAWN', 'The student has withdrawn this application'],
    needs_info: ['WAITING_FOR_STUDENT', 'This application is waiting for the student\'s reply'],
};
const refusalFor = (currentStatus) => REFUSED_FROM[currentStatus] || ['ALREADY_DECIDED', 'This application can no longer be decided'];

const problem = (field, code, message, params) => ({ field, code, message, ...(params ? { params } : {}) });

/**
 * Checks a decision request. Returns { errors } (field errors for sendValidationErrors) or
 * { decision: { status, note, finalGrade } } with the note trimmed (null when empty).
 * - approved: final_grade a whole number 2-5 (required); the note is optional
 * - rejected: the rationale (note) is required
 * - needs_info: the message to the student (note) is required
 * - every text: at most NOTE_MAX characters
 */
const checkDecision = (body = {}) => {
    const { status, note, final_grade: grade } = body;
    if (!DECISIONS.includes(status)) return { errors: [problem('status', 'INVALID_STATUS', 'This status is not valid')] };

    const errors = [];
    if (note !== undefined && note !== null && typeof note !== 'string') errors.push(problem('note', 'INVALID_FIELD', 'The note must be text'));
    const text = typeof note === 'string' ? normalizeNote(note).trim() : '';
    if (noteLength(text) > NOTE_MAX) errors.push(problem('note', 'NOTE_TOO_LONG', `The note can be at most ${NOTE_MAX} characters`, { max: NOTE_MAX }));

    let finalGrade = null;
    if (status === 'approved') {
        if (grade === undefined || grade === null || grade === '') errors.push(problem('final_grade', 'GRADE_REQUIRED', 'Choose the final grade'));
        else if (!(typeof grade === 'number' && FINAL_GRADES.includes(grade))) errors.push(problem('final_grade', 'INVALID_FINAL_GRADE', 'The final grade must be 2, 3, 4 or 5'));
        else finalGrade = grade;
    } else if (grade !== undefined && grade !== null) {
        errors.push(problem('final_grade', 'GRADE_ONLY_ON_APPROVE', 'A final grade is only given with an approval'));
    }
    if (status === 'rejected' && !text) errors.push(problem('note', 'RATIONALE_REQUIRED', 'Give the reason for the rejection'));
    if (status === 'needs_info' && !text) errors.push(problem('note', 'MESSAGE_REQUIRED', 'Write what the student should send'));

    if (errors.length) return { errors };
    return { decision: { status, note: text || null, finalGrade } };
};

module.exports = { DECIDABLE_STATUS, DECISIONS, FINAL_GRADES, refusalFor, checkDecision };
