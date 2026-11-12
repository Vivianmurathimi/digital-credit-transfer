// The committee step (round 2 Group 2 Part C), in one place: the committee's route and the admin's
// direct step both use it, so the rules are the same.
//
// After a reviewer or an admin approves or rejects, the application awaits the programme's committee
// (status awaiting_committee). The committee acts as a body: KEEP the decision or CHANGE it. Then
// status and final_grade are the final result, and the student is told.
//   - approved, KEEP:   the reviewer's grade stays; the committee MAY give another grade
//   - approved, CHANGE: rejected; the final grade is empty (the reviewer's stays in reviewer_grade)
//   - rejected, KEEP:   rejected, no grade
//   - rejected, CHANGE: approved; a grade is REQUIRED (there is none yet)
//   - the note is optional on Keep, required on Change
// One step only: a conditional update ("while awaiting"), so of two members at once one succeeds and
// the other gets 409 ALREADY_DECIDED; after that it is final, no reopening. Whoever made the
// reviewer decision (decided_by) can never take the committee step on it (409 OWN_DECISION), whatever
// their links. Records say "Committee"; committee_by keeps who acted (shown to the admin only).

const { NOTE_MAX, normalizeNote, noteLength } = require('./applicationForm');
const { semesterEndedSql } = require('./semesters');
const { addEvent } = require('./applicationEvents');

const ACTIONS = ['keep', 'change'];
const FINAL_GRADES = [2, 3, 4, 5];

// Which applications the committee sees: decided by a reviewer or admin, awaiting or already handled
// by the committee. Never pending, needs info, withdrawn, System decisions or older ones (alias a).
const COMMITTEE_VISIBLE_SQL = (a = 'a') => `${a}.committee_state IN ('awaiting', 'kept', 'changed')`;

const problem = (field, code, message, params) => ({ field, code, message, ...(params ? { params } : {}) });

/**
 * Checks the request on its own: { errors } or { step: { action, finalGrade, note } }. What the
 * reviewer decided is checked in takeCommitteeStep (it needs the application).
 */
const checkCommitteeStep = (body = {}) => {
    const { action, final_grade: grade, note } = body;
    if (!ACTIONS.includes(action)) return { errors: [problem('action', 'INVALID_ACTION', 'action must be keep or change')] };
    const errors = [];
    if (note !== undefined && note !== null && typeof note !== 'string') errors.push(problem('note', 'INVALID_FIELD', 'The note must be text'));
    const text = typeof note === 'string' ? normalizeNote(note).trim() : '';
    if (noteLength(text) > NOTE_MAX) errors.push(problem('note', 'NOTE_TOO_LONG', `The note can be at most ${NOTE_MAX} characters`, { max: NOTE_MAX }));
    if (action === 'change' && !text) errors.push(problem('note', 'COMMITTEE_NOTE_REQUIRED', 'Say why the committee changes the decision'));
    let finalGrade = null;
    if (grade !== undefined && grade !== null && grade !== '') {
        if (!(typeof grade === 'number' && FINAL_GRADES.includes(grade))) errors.push(problem('final_grade', 'INVALID_FINAL_GRADE', 'The final grade must be 2, 3, 4 or 5'));
        else finalGrade = grade;
    }
    if (errors.length) return { errors };
    return { step: { action, finalGrade, note: text || null } };
};

/**
 * Takes the committee step inside the caller's transaction.
 * @param {{ applicationId, step, actorId, actorRole: 'committee'|'admin', programmeIds: number[]|null }} input
 *   programmeIds: the member's committee programmes; null for the admin (every programme)
 * @returns {Promise<{ error?: [status, code, message, field?], done?: { studentId, status, finalGrade, emailNote } }>}
 */
const takeCommitteeStep = async (client, { applicationId, step, actorId, actorRole, programmeIds }) => {
    const app = (await client.query(
        `SELECT a.id, a.student_id, a.status, a.reviewer_decision, a.reviewer_grade, a.decided_by, a.decision_rationale, a.committee_state,
                ${semesterEndedSql('a')} AS semester_closed
         FROM applications a
         WHERE a.id = $1 AND ($2::int[] IS NULL OR a.programme_id = ANY($2::int[])) AND ${COMMITTEE_VISIBLE_SQL('a')}
         FOR UPDATE OF a`,
        [applicationId, programmeIds]
    )).rows[0];
    // Not there, another programme's, or not a committee matter (pending, System...): the same 404
    if (!app) return { error: [404, 'APPLICATION_NOT_FOUND', 'Application not found'] };
    if (app.status !== 'awaiting_committee') return { error: [409, 'ALREADY_DECIDED', 'The committee has already decided this application'] };
    if (app.semester_closed) return { error: [409, 'SEMESTER_ENDED', 'The semester has ended, so the application can no longer be changed'] };
    if (app.decided_by !== null && app.decided_by === actorId) {
        return { error: [409, 'OWN_DECISION', 'You made the reviewer decision on this application: another committee member confirms it'] };
    }

    const finalStatus = step.action === 'keep' ? app.reviewer_decision : (app.reviewer_decision === 'approved' ? 'rejected' : 'approved');
    let finalGrade = null;
    if (finalStatus === 'approved') {
        finalGrade = step.finalGrade ?? (step.action === 'keep' ? app.reviewer_grade : null);
        if (finalGrade === null) return { error: [400, 'GRADE_REQUIRED', 'The reviewer rejected this, so there is no grade yet: choose the final grade', 'final_grade'] };
    } else if (step.finalGrade !== null) {
        return { error: [400, 'GRADE_ONLY_ON_APPROVE', 'A final grade is only given with an approval', 'final_grade'] };
    }

    const kind = step.action === 'keep' ? 'kept' : 'changed';
    const { rowCount } = await client.query(
        `UPDATE applications SET status = $2, final_grade = $3, committee_state = $4, committee_by = $5, committee_by_role = $6,
                committee_at = now(), committee_note = $7
         WHERE id = $1 AND status = 'awaiting_committee'`,
        [applicationId, finalStatus, finalGrade, kind, actorId, actorRole, step.note]
    );
    if (rowCount === 0) return { error: [409, 'ALREADY_DECIDED', 'The committee has already decided this application'] };
    await addEvent(client, {
        applicationId, kind: `committee_${kind}`, actorRole, actorId, status: finalStatus, note: step.note,
    });
    // What the student is told: on Keep the reviewer's reason plus the committee's note, on Change only the committee's note
    const emailNote = kind === 'kept' ? [app.decision_rationale, step.note].filter(Boolean).join('\n\n') || null : step.note;
    return { done: { studentId: app.student_id, status: finalStatus, finalGrade, emailNote } };
};

module.exports = { ACTIONS, COMMITTEE_VISIBLE_SQL, checkCommitteeStep, takeCommitteeStep };
