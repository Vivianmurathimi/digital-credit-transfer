/**
 * The committee step's data model (migration 023, round 2 Group 2 Part B): the database rules.
 *
 *   npm test
 *
 * A temporary student (@committee-model-test.invalid) with applications in the first programme;
 * all deleted afterwards.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

const run = Date.now().toString(36).toUpperCase();
let student;
const apps = [];

const insert = (fields) => {
    const columns = ['student_id', 'programme_id', 'institutions', 'target_courses', 'target_course_code', ...Object.keys(fields)];
    const values = [student.id, student.programme_id, '[]', JSON.stringify([{ course_code: `CM${run}` }]), `CM${run}`.slice(0, 20), ...Object.values(fields)];
    return pool.query(
        `INSERT INTO applications (${columns.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, values
    ).then((r) => { apps.push(r.rows[0].id); return r.rows[0].id; });
};
// Refused by one of these rules (a row breaking two rules is reported by one of them)
const refused = async (promise, ...constraints) => {
    try { await promise; return false; } catch (err) { return constraints.includes(err.constraint); }
};

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    const programme = (await pool.query('SELECT id FROM programmes ORDER BY id LIMIT 1')).rows[0];
    student = (await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
         VALUES ('Committee Model Test', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id, programme_id`,
        [`cm-${run.toLowerCase()}@committee-model-test.invalid`, `C${run.slice(-5)}`.padEnd(6, 'C').slice(0, 6), programme.id]
    )).rows[0];
});

after(async () => {
    if (apps.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [apps]);
    await pool.query('DELETE FROM users WHERE id = $1', [student.id]);
    await pool.end();
});

const AWAITING_REJECTED = {
    status: 'awaiting_committee', reviewer_decision: 'rejected', committee_state: 'awaiting',
    decided_by_role: 'reviewer', decided_at: new Date(), decision_rationale: 'Different content',
};

test('awaiting the committee: the reviewer decision is there, no final grade yet', async () => {
    assert.ok(await refused(insert({ status: 'awaiting_committee', committee_state: 'awaiting' }), 'applications_awaiting_has_decision'),
        'without a reviewer decision: refused');
    assert.ok(await refused(insert({ ...AWAITING_REJECTED, final_grade: 4 }), 'applications_final_grade_only_approved', 'applications_awaiting_has_decision'),
        'with a final grade: refused');
    assert.ok(await refused(insert({ ...AWAITING_REJECTED, reviewer_decision: 'approved' }), 'applications_reviewer_grade_with_approval'),
        "an approval without the reviewer's grade: refused");
    assert.ok(await refused(insert({ ...AWAITING_REJECTED, committee_state: 'kept' }), 'applications_committee_state_matches'),
        'awaiting with another committee state: refused');
    const id = await insert(AWAITING_REJECTED);
    assert.ok(id, 'a reviewer-rejected application awaiting the committee is saved');
    await pool.query('DELETE FROM applications WHERE id = $1', [id]);
    apps.splice(apps.indexOf(id), 1);
});

test('the duplicate rule counts an application awaiting the committee, even one the reviewer rejected', async () => {
    const first = await insert(AWAITING_REJECTED);
    assert.ok(await refused(insert({ status: 'pending' }), 'applications_one_active_per_course'),
        'a second application for the same course: refused while the first awaits the committee');
    // The committee keeps the rejection: final, a new application is allowed again
    await pool.query(
        `UPDATE applications SET status = 'rejected', committee_state = 'kept', committee_by_role = 'committee', committee_at = now() WHERE id = $1`, [first]
    );
    const again = await insert({ status: 'pending' });
    assert.ok(again, 'after the final rejection a new application is allowed');
    await pool.query('DELETE FROM applications WHERE id = ANY($1)', [[first, again]]);
    apps.splice(0, apps.length);
});

test("the committee's step: complete, and a change always says why", async () => {
    const id = await insert(AWAITING_REJECTED);
    const change = (fields) => pool.query(
        `UPDATE applications SET status = 'approved', final_grade = 4, committee_state = 'changed',
            committee_by_role = $2, committee_at = $3, committee_note = $4 WHERE id = $1`,
        [id, fields.role, fields.at, fields.note]
    );
    assert.ok(await refused(change({ role: 'committee', at: new Date(), note: '  ' }), 'applications_committee_change_has_note'), 'a change without a note: refused');
    assert.ok(await refused(change({ role: 'committee', at: null, note: 'x' }), 'applications_committee_step_complete'), 'a step without its time: refused');
    assert.ok(await refused(change({ role: 'reviewer', at: new Date(), note: 'x' }), 'applications_committee_by_role_known'), 'taken by a reviewer: refused');
    await change({ role: 'committee', at: new Date(), note: 'Equivalent after all' });
    const row = (await pool.query('SELECT status, final_grade, reviewer_decision, committee_state FROM applications WHERE id = $1', [id])).rows[0];
    assert.deepEqual(row, { status: 'approved', final_grade: 4, reviewer_decision: 'rejected', committee_state: 'changed' },
        "the final result is the committee's; the reviewer's decision stays");
    assert.ok(await refused(pool.query("UPDATE applications SET status = 'approved', final_grade = 4, committee_state = NULL WHERE id = $1", [id]),
        'applications_committee_state_matches', 'applications_committee_step_taken'), 'a final decision without a committee state: refused');
});
