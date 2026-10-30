const pool = require('../db');
const notifyStudent = require('../utils/notifyStudent');
const inTransaction = require('../utils/transaction');

// Background steps for applications (Group 9), run regularly by jobs/scheduler.js.
//
// Nothing is kept in memory: every step reads and writes only the database, so a restart loses
// nothing. Each change is one atomic UPDATE that applies only while its condition still holds
// (e.g. "still needs_info and past the deadline"), so two backend processes running the same step
// at the same moment can't both act on the same application: the second finds nothing to do.
// Emails go out after the change is saved; a failed email is logged and never undoes it.
//
// Every step takes { now, notify, only }: `now` is the time to compare against (a fixed time in the
// tests, the real time otherwise), `notify` sends the student email (notifyStudent by default),
// and `only` (tests only) limits the step to these application ids, so a test never touches real data.

const REMINDER_BEFORE = '24 hours';

// Automatic rejection reasons: the code is stored (the student side translates it), the English
// text is stored as the reviewer note (for the reviewer screen, admin screen and term book)
const REJECTION_REASONS = {
    NO_INFO_RESPONSE: 'No response to information request.',
};

// Sends each email on its own, so one failure never stops the others
const notifyEach = async (rows, notify, type, dataFor) => {
    let sent = 0;
    for (const row of rows) {
        try {
            await notify(row.student_id, type, { ...dataFor(row), applicationId: row.id });
            sent += 1;
        } catch (err) {
            console.error(`❌ ${type} email for application ${row.id} failed:`, err.message);
        }
    }
    return sent;
};

/**
 * One reminder, 24 hours before the reply deadline. Recorded before the email is sent,
 * so it is never sent twice (if that email fails, the student still has the first email
 * and the deadline on screen).
 */
const sendDeadlineReminders = async ({ now, notify = notifyStudent, only = null }) => {
    const { rows } = await pool.query(
        `UPDATE applications SET info_reminder_sent_at = $1
         WHERE status = 'needs_info' AND info_reminder_sent_at IS NULL
           AND info_deadline > $1 AND info_deadline - INTERVAL '${REMINDER_BEFORE}' <= $1
           AND ($2::int[] IS NULL OR id = ANY($2))
         RETURNING id, student_id, info_deadline`,
        [now, only]
    );
    await notifyEach(rows, notify, 'reminder', (row) => ({ deadline: row.info_deadline }));
    return rows.length;
};

/**
 * Rejects, as "System", every application matching `condition` (a fixed SQL condition written in
 * this file, never user input), with a reason code from REJECTION_REASONS. The status change and
 * the history entry are saved together; then each student gets the status email.
 * Group 3 can reuse this for the semester-end rejection with its own condition and reason.
 */
const rejectAutomatically = async ({ now, notify = notifyStudent, only = null, condition, reasonCode }) => {
    const note = REJECTION_REASONS[reasonCode];
    if (!note) throw new Error(`Unknown rejection reason ${reasonCode}`);

    const rows = await inTransaction(async (client) => {
        // reviewed_at is stored as UTC without a time zone; reviewed_by NULL = nobody, the system
        const updated = await client.query(
            `UPDATE applications
             SET status = 'rejected', reviewer_note = $2, reviewed_by = NULL, reviewed_at = $1::timestamptz AT TIME ZONE 'UTC',
                 info_requested_at = NULL, info_deadline = NULL, info_reminder_sent_at = NULL
             WHERE (${condition}) AND ($3::int[] IS NULL OR id = ANY($3))
             RETURNING id, student_id`,
            [now, note, only]
        );
        if (updated.rows.length > 0) {
            await client.query(
                `INSERT INTO application_events (application_id, kind, actor_role, status, note, reason_code, created_at)
                 SELECT unnest($1::int[]), 'auto_rejected', 'system', 'rejected', $2, $3, $4`,
                [updated.rows.map((r) => r.id), note, reasonCode, now]
            );
        }
        return updated.rows;
    });
    await notifyEach(rows, notify, 'statusUpdate', () => ({ status: 'rejected', reasonCode }));
    return rows.length;
};

// No reply by the deadline: rejected with "No response to information request."
const rejectOverdueInfoRequests = ({ now, notify, only }) => rejectAutomatically({
    now, notify, only, reasonCode: 'NO_INFO_RESPONSE',
    condition: "status = 'needs_info' AND info_deadline <= $1",
});

// The steps of one run, in order. Group 3 adds its semester-end step here.
const STEPS = [
    ['deadline reminders', sendDeadlineReminders],
    ['overdue information requests', rejectOverdueInfoRequests],
];

/**
 * One run of every step. A failing step is logged and the next one still runs.
 * @returns {Promise<Record<string, number|string>>} what each step did (count, or 'failed')
 */
const runApplicationJobs = async ({ now = new Date(), notify = notifyStudent, only = null } = {}) => {
    const results = {};
    for (const [name, step] of STEPS) {
        try {
            results[name] = await step({ now, notify, only });
            if (results[name] > 0) console.log(`⏱️  Background job, ${name}: ${results[name]}`);
        } catch (err) {
            results[name] = 'failed';
            console.error(`❌ Background job, ${name} failed:`, err.message);
        }
    }
    return results;
};

module.exports = { runApplicationJobs, sendDeadlineReminders, rejectOverdueInfoRequests, rejectAutomatically, REJECTION_REASONS };
