/**
 * Tests for the background jobs (jobs/applicationJobs.js) with a fake clock:
 *
 *   npm test
 *
 * Uses the database from backend/.env (run "npm run migrate" first). It adds its own test
 * applications and deletes them afterwards, together with their history; no email is sent
 * (a fake notify function records them). Every run is limited to the test's own applications
 * (`only`), so real applications are never touched; and the fake clock is 60 days in the future,
 * so a backend running its real jobs at the same time never touches the test applications.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { runApplicationJobs, sendDeadlineReminders, rejectOverdueInfoRequests } = require('../jobs/applicationJobs');

const HOUR = 60 * 60 * 1000;
const BASE = new Date(Date.now() + 60 * 24 * HOUR); // the fake "today"
const at = (offsetMs) => new Date(BASE.getTime() + offsetMs);

let student;
const created = [];
const run = Date.now().toString(36);

// A fake notify: records every email instead of sending it; can be told to fail for one application
const recorder = ({ failFor } = {}) => {
    const sent = [];
    const notify = async (studentId, type, data) => {
        if (failFor && failFor(studentId, type, data)) throw new Error('SMTP down (test)');
        sent.push({ studentId, type, data });
    };
    return { sent, notify };
};

// A test application waiting for information, with a deadline (default: 3 days after BASE)
const waitingApplication = async ({ deadline = at(72 * HOUR), status = 'needs_info' } = {}) => {
    const code = `JOBTEST${run}${created.length}`.toUpperCase();
    const { rows } = await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status, reviewer_note,
                                   info_requested_at, info_deadline)
         VALUES ($1, $2, '[]', $3, $4, $5, 'Please add the syllabus.', $6, $7) RETURNING id`,
        [student.id, student.programme_id, JSON.stringify([{ course_code: code, course_name: 'Job test', credits: 1 }]), code, status,
            status === 'needs_info' ? BASE : null, status === 'needs_info' ? deadline : null]
    );
    created.push(rows[0].id);
    return rows[0].id;
};
const read = async (id) => (await pool.query('SELECT status, reviewer_note, info_deadline, info_reminder_sent_at, reviewed_by FROM applications WHERE id = $1', [id])).rows[0];
const eventsOf = async (id) => (await pool.query('SELECT kind, actor_role, actor_id, status, note, reason_code, created_at FROM application_events WHERE application_id = $1 ORDER BY id', [id])).rows;
const emailsFor = (sent, id, type) => sent.filter((e) => e.data.applicationId === id && (!type || e.type === type));

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    student = (await pool.query("SELECT id, programme_id FROM users WHERE role = 'student' AND programme_id IS NOT NULL ORDER BY id LIMIT 1")).rows[0];
    assert.ok(student, 'needs one student with a programme (npm run seed:dev)');
});

after(async () => {
    // Deleting the applications also deletes their history (the only way events can be deleted)
    if (created.length) await pool.query('DELETE FROM applications WHERE id = ANY($1)', [created]);
    await pool.end();
});

test('the deadline is 23:59:59 Budapest time on the third day, also across a clock change', async () => {
    const deadline = async (requestedAt) => (await pool.query('SELECT info_reply_deadline($1::timestamptz) AS d', [requestedAt])).rows[0].d.toISOString();
    // Requested the day before winter time starts (25 Oct 2026): deadline in winter time (UTC+1)
    assert.equal(await deadline('2026-10-24T10:00:00Z'), '2026-10-27T22:59:59.000Z');
    // 23:30 in Budapest (still 24 Oct there) counts as 24 Oct, not 25 Oct
    assert.equal(await deadline('2026-10-24T21:30:00Z'), '2026-10-27T22:59:59.000Z');
    // Requested the day before summer time starts (29 Mar 2026): deadline in summer time (UTC+2)
    assert.equal(await deadline('2026-03-28T09:00:00Z'), '2026-03-31T21:59:59.000Z');
});

test('one reminder 24 hours before the deadline, never twice', async () => {
    const id = await waitingApplication();
    const deadline = at(72 * HOUR);
    const { sent, notify } = recorder();
    const remindersFor = () => emailsFor(sent, id, 'reminder');
    const only = [id];

    await sendDeadlineReminders({ now: new Date(deadline - 25 * HOUR), notify, only });
    assert.equal((await read(id)).info_reminder_sent_at, null, 'not yet 25 hours before');

    await sendDeadlineReminders({ now: new Date(deadline - 23 * HOUR), notify, only });
    assert.ok((await read(id)).info_reminder_sent_at, 'recorded');
    assert.equal(remindersFor().length, 1);
    assert.equal(remindersFor()[0].data.deadline.toISOString(), deadline.toISOString(), 'the email carries the deadline');

    await sendDeadlineReminders({ now: new Date(deadline - 22 * HOUR), notify, only });
    await sendDeadlineReminders({ now: new Date(deadline - 1 * HOUR), notify, only });
    assert.equal(remindersFor().length, 1, 'still only one');
});

test('rejected at the deadline as "System", with the reason code, history entry and status email', async () => {
    const id = await waitingApplication();
    const deadline = at(72 * HOUR);
    const { sent, notify } = recorder();

    const only = [id];
    await rejectOverdueInfoRequests({ now: new Date(deadline - 1000), notify, only });
    assert.equal((await read(id)).status, 'needs_info', 'one second before: still waiting');

    await rejectOverdueInfoRequests({ now: deadline, notify, only });
    const row = await read(id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.reviewer_note, 'No response to information request.');
    assert.equal(row.reviewed_by, null, 'decided by nobody: the system');
    assert.equal(row.info_deadline, null, 'deadline cleared');

    const last = (await eventsOf(id)).at(-1);
    assert.deepEqual(
        { kind: last.kind, actor_role: last.actor_role, actor_id: last.actor_id, status: last.status, reason_code: last.reason_code },
        { kind: 'auto_rejected', actor_role: 'system', actor_id: null, status: 'rejected', reason_code: 'NO_INFO_RESPONSE' }
    );
    assert.equal(last.created_at.toISOString(), deadline.toISOString(), 'recorded at the (fake) time of the run');

    const emails = emailsFor(sent, id, 'statusUpdate');
    assert.equal(emails.length, 1);
    assert.deepEqual(emails[0].data, { status: 'rejected', reasonCode: 'NO_INFO_RESPONSE', applicationId: id });

    await rejectOverdueInfoRequests({ now: new Date(deadline.getTime() + HOUR), notify, only });
    assert.equal((await eventsOf(id)).filter((e) => e.kind === 'auto_rejected').length, 1, 'a later run does nothing more');
    assert.equal(sent.length, 1);
});

test('nothing happens after the student replied', async () => {
    // A reply sets the status back to pending and clears the deadline
    const id = await waitingApplication({ status: 'pending' });
    const { sent, notify } = recorder();
    await runApplicationJobs({ now: at(10 * 24 * HOUR), notify, only: [id] });
    assert.equal((await read(id)).status, 'pending');
    assert.equal((await eventsOf(id)).length, 0);
    assert.equal(sent.length, 0);
});

test('two runs at the same moment (e.g. two backend processes) reject each application once', async () => {
    const ids = [await waitingApplication(), await waitingApplication(), await waitingApplication()];
    const now = at(73 * HOUR);
    const first = recorder();
    const second = recorder();

    await Promise.all([
        rejectOverdueInfoRequests({ now, notify: first.notify, only: ids }),
        rejectOverdueInfoRequests({ now, notify: second.notify, only: ids }),
    ]);

    for (const id of ids) {
        assert.equal((await read(id)).status, 'rejected');
        assert.equal((await eventsOf(id)).filter((e) => e.kind === 'auto_rejected').length, 1, `one history entry for ${id}`);
    }
    // Every application emailed exactly once in total, whichever run handled it
    assert.equal(first.sent.length + second.sent.length, ids.length);
});

test('a failed email never undoes the rejection or stops the others', async () => {
    const ids = [await waitingApplication(), await waitingApplication()];
    // The first application's email fails, the second one's goes through
    const { sent, notify } = recorder({ failFor: (studentId, type, data) => data.applicationId === ids[0] });

    const count = await rejectOverdueInfoRequests({ now: at(74 * HOUR), notify, only: ids });
    assert.equal(count, 2);
    for (const id of ids) assert.equal((await read(id)).status, 'rejected', 'rejected, email or not');
    assert.equal(emailsFor(sent, ids[1]).length, 1, 'the second email was still sent');
});

test('a full run does the reminder and the rejection steps together', async () => {
    const soon = await waitingApplication({ deadline: at(80 * HOUR) });
    const overdue = await waitingApplication({ deadline: at(50 * HOUR) });
    const { notify } = recorder();
    const results = await runApplicationJobs({ now: at(60 * HOUR), notify, only: [soon, overdue] });
    assert.deepEqual(results, { 'deadline reminders': 1, 'overdue information requests': 1 });
    assert.ok((await read(soon)).info_reminder_sent_at);
    assert.equal((await read(overdue)).status, 'rejected');
});
