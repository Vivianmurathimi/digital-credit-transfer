/**
 * The committee's choices (fixes Part A) and the student's own PDF data (fixes 4a):   npm test
 *
 * The real step (utils/committee.js) on applications of a temporary student
 * (@committee-grade-test.invalid) in the first programme; all deleted afterwards.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const inTransaction = require('../utils/transaction');
const { checkCommitteeStep, takeCommitteeStep } = require('../utils/committee');
const { getApplicationTermData } = require('../utils/getTermData');

const run = Date.now().toString(36).toUpperCase();
let student;
let other;
const apps = [];
let seq = 0;

const makeStudent = async (tag) => (await pool.query(
    `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
     VALUES ($1, $2, 'not-a-password-hash', 'student', true, $3, (SELECT id FROM programmes ORDER BY id LIMIT 1)) RETURNING id, programme_id`,
    [`Committee Grade ${tag}`, `cg-${tag}-${run.toLowerCase()}@committee-grade-test.invalid`, `${tag}${run.slice(-5)}`.padEnd(6, 'G').slice(0, 6)]
)).rows[0];

// An application awaiting the committee: the reviewer approved with 4, or rejected
const awaiting = async (decision, { reviewedBy = null } = {}) => {
    seq += 1;
    const code = `CG${run}${seq}`.slice(0, 20);
    const id = (await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status,
             reviewer_decision, reviewer_grade, decided_by_role, decided_at, decision_rationale, committee_state, reviewer_note, reviewed_by)
         VALUES ($1, $2, '[]', $3, $4, 'awaiting_committee', $5, $6, 'reviewer', now(), 'The reviewer''s reason', 'awaiting', 'Internal decision note', $7)
         RETURNING id`,
        [student.id, student.programme_id, JSON.stringify([{ course_code: code, course_name: 'Committee grade test' }]), code,
            decision, decision === 'approved' ? 4 : null, reviewedBy]
    )).rows[0].id;
    apps.push(id);
    return id;
};
// The whole step as the route takes it: the request check, then the step in a transaction
const step = async (id, body, actorRole = 'committee') => {
    const checked = checkCommitteeStep(body);
    if (checked.errors) return { refused: checked.errors[0].code };
    const result = await inTransaction((client) => takeCommitteeStep(client, { applicationId: id, step: checked.step, actorId: null, actorRole, programmeIds: null }));
    return result.error ? { refused: result.error[1] } : result.done;
};
const rowOf = async (id) => (await pool.query(
    'SELECT status, final_grade, reviewer_grade, committee_grade, committee_state, committee_by_role, committee_note FROM applications WHERE id = $1', [id]
)).rows[0];

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    student = await makeStudent('G');
    other = await makeStudent('H');
});

after(async () => {
    if (apps.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [apps]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[student.id, other.id]]);
    await pool.end();
});

test('approved, Keep: the reviewer\'s grade stays; a grade is refused', async () => {
    const id = await awaiting('approved');
    assert.equal((await step(id, { action: 'keep', final_grade: 5 })).refused, 'GRADE_NOT_ON_KEEP');
    const done = await step(id, { action: 'keep' });
    assert.deepEqual([done.status, done.finalGrade], ['approved', 4]);
    assert.deepEqual(await rowOf(id), { status: 'approved', final_grade: 4, reviewer_grade: 4, committee_grade: null, committee_state: 'kept', committee_by_role: 'committee', committee_note: null });
});

test('approved, Change the grade: still approved, the committee\'s grade, no note needed, counted as changed', async () => {
    const id = await awaiting('approved');
    assert.equal((await step(id, { action: 'change_grade' })).refused, 'GRADE_REQUIRED');
    assert.equal((await step(id, { action: 'change_grade', final_grade: 4 })).refused, 'GRADE_UNCHANGED', "the reviewer's grade");
    assert.equal((await step(id, { action: 'change_grade', final_grade: 7 })).refused, 'INVALID_FINAL_GRADE');
    assert.equal((await step(id, { action: 'change_grade', final_grade: '3' })).refused, 'INVALID_FINAL_GRADE', 'a grade as text');
    const done = await step(id, { action: 'change_grade', final_grade: 3 });
    assert.deepEqual([done.status, done.finalGrade], ['approved', 3]);
    assert.match(done.emailNote, /reviewer's reason/, 'the decision stayed: the student gets the reviewer\'s reason');
    assert.deepEqual(await rowOf(id), { status: 'approved', final_grade: 3, reviewer_grade: 4, committee_grade: 3, committee_state: 'changed', committee_by_role: 'committee', committee_note: null });
    assert.equal((await step(id, { action: 'change_grade', final_grade: 2 })).refused, 'ALREADY_DECIDED', 'only while awaiting the committee');
});

test('a rejection has no grade to change', async () => {
    const id = await awaiting('rejected');
    assert.equal((await step(id, { action: 'change_grade', final_grade: 3 })).refused, 'NOT_APPROVED');
    assert.equal((await rowOf(id)).status, 'awaiting_committee');
});

test('approved, Change to rejected: a note is required, no grade', async () => {
    const id = await awaiting('approved');
    assert.equal((await step(id, { action: 'change' })).refused, 'COMMITTEE_NOTE_REQUIRED');
    assert.equal((await step(id, { action: 'change', note: 'Not equivalent', final_grade: 3 })).refused, 'GRADE_ONLY_ON_APPROVE');
    const done = await step(id, { action: 'change', note: 'Not equivalent' });
    assert.deepEqual([done.status, done.finalGrade, done.emailNote], ['rejected', null, 'Not equivalent']);
    assert.deepEqual(await rowOf(id), { status: 'rejected', final_grade: null, reviewer_grade: 4, committee_grade: null, committee_state: 'changed', committee_by_role: 'committee', committee_note: 'Not equivalent' });
});

test('rejected, Change to approved: a grade and a note are required; the admin acting as committee is recorded as admin', async () => {
    const id = await awaiting('rejected');
    assert.equal((await step(id, { action: 'change', note: 'Equivalent after all' })).refused, 'GRADE_REQUIRED');
    const done = await step(id, { action: 'change', note: 'Equivalent after all', final_grade: 5 }, 'admin');
    assert.deepEqual([done.status, done.finalGrade], ['approved', 5]);
    assert.deepEqual(await rowOf(id), { status: 'approved', final_grade: 5, reviewer_grade: null, committee_grade: 5, committee_state: 'changed', committee_by_role: 'admin', committee_note: 'Equivalent after all' });
});

test('an unknown action is refused', async () => {
    assert.equal(checkCommitteeStep({ action: 'regrade' }).errors[0].code, 'INVALID_ACTION');
});

test("the student's PDF copy: only their own application, only what they may see", async () => {
    const id = await awaiting('approved', { reviewedBy: other.id });
    assert.equal(await getApplicationTermData(id, { studentId: other.id }), null, "another student's application: nothing");

    // Awaiting the committee: no reviewer, no internal note, no reviewer decision
    let data = await getApplicationTermData(id, { studentId: student.id });
    let [app] = data.applications;
    assert.equal(data.studentCopy, true);
    assert.deepEqual([app.reviewer, app.decision, app.notes.reviewer], [null, null, null]);

    // After a grade change: the final result as the student sees it
    await step(id, { action: 'change_grade', final_grade: 3, note: 'A closer match to satisfactory' });
    data = await getApplicationTermData(id, { studentId: student.id });
    [app] = data.applications;
    assert.deepEqual(app.decision, {
        finalGrade: 3, decidedBy: 'Committee', decidedAt: app.decision.decidedAt, rationale: "The reviewer's reason", reasonCode: null,
        reviewerDecision: null, reviewerGrade: null, committee: { state: null, note: 'A closer match to satisfactory' },
    });
    assert.deepEqual([app.reviewer, app.notes.reviewer], [null, null]);

    // The staff copy shows both steps
    const staff = (await getApplicationTermData(id)).applications[0];
    assert.deepEqual([staff.decision.reviewerDecision, staff.decision.reviewerGrade, staff.decision.committee.outcome, staff.decision.committee.grade], ['approved', 4, 'grade_changed', 3]);
    assert.equal(staff.reviewer.name, 'Committee Grade H');
});
