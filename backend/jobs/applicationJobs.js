const pool = require('../db');
const notifyStudent = require('../utils/notifyStudent');
const sendEmail = require('../utils/sendEmail');
const { buildReviewerEmail, buildReviewerSummaryEmail, buildAdminEmail } = require('../utils/emailTemplates');
const { seesProgrammeSql } = require('../utils/reviewers');
const inTransaction = require('../utils/transaction');
const { REVIEW_WARNING_DAYS } = require('../utils/semesters');

// Background steps for applications (Group 9), run regularly by jobs/scheduler.js.
//
// Nothing is kept in memory: every step reads and writes only the database, so a restart loses
// nothing. Each change is one atomic UPDATE that applies only while its condition still holds
// (e.g. "still needs_info and past the deadline"), so two backend processes running the same step
// at the same moment can't both act on the same application: the second finds nothing to do.
// Emails go out after the change is saved; a failed email is logged and never undoes it.
//
// Every step takes { now, notify, remind, only, onlyDraftsOf }: `now` is the time to compare against
// (a fixed time in the tests and with `npm run jobs:run -- --now=...`, the real time otherwise),
// `notify` sends the student email (notifyStudent by default), `remind` the reviewer's review-deadline
// reminder (remindReviewer by default), `alert` the admins' review-deadline email (alertAdmins by
// default), `summarize` the reviewer's daily summary (sendReviewerSummary by default), and `only` /
// `onlyDraftsOf` / `onlyReviewers` (tests only) limit the step to these application ids, these
// students' drafts and these reviewers, so a test never touches real data.
//
// Catching up: every condition compares with `now` ("the deadline has passed", "the last days have
// started"), so whatever passed while the server was off is handled by the first run after it starts.
// All moments are Budapest time, worked out in the database (semester_bounds, info_reply_deadline).

const REMINDER_BEFORE = '24 hours';

// Automatic rejection reasons (reviewer Group 7): only the CODE is stored, in the history
// (application_events.reason_code). Every screen, email and the term book translate it
// (frontend student_reason_* keys, the email `reasons` table, the term book in English).
// SEMESTER_ENDED is no longer given (round 2 Group 1: closing rejects nobody); it stays for the
// records of earlier closes.
const REJECTION_REASONS = ['NO_INFO_RESPONSE', 'SEMESTER_ENDED'];

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
/**
 * Rejects as "System" the applications matching `condition`, inside the caller's transaction, and
 * adds the history entries. $1 is `now`, $2 the `only` list (tests), extra `params` start at $3.
 * Used by the deadline step below and by the admin's semester close (utils/semesterClose.js), so
 * there is one way to reject automatically. Returns the rejected rows; emails are the caller's.
 */
const rejectInTransaction = async (client, { now, condition, params = [], only = null, reasonCode }) => {
    if (!REJECTION_REASONS.includes(reasonCode)) throw new Error(`Unknown rejection reason ${reasonCode}`);
    // reviewed_at is stored as UTC without a time zone; reviewed_by NULL = nobody, the system.
    // The decision (reviewer Group 1): by the system, now. No text: the reason is the code in the
    // history entry (the reviewer's earlier message, e.g. the request for information, is cleared).
    const updated = await client.query(
        `UPDATE applications
         SET status = 'rejected', reviewer_note = NULL, reviewed_by = NULL, reviewed_at = $1::timestamptz AT TIME ZONE 'UTC',
             info_requested_at = NULL, info_deadline = NULL, info_reminder_sent_at = NULL,
             final_grade = NULL, decided_by = NULL, decided_by_role = 'system', decided_at = $1, decision_rationale = NULL,
             -- final at once: a System decision never goes to the committee (round 2 Group 2)
             committee_state = 'not_needed'
         WHERE (${condition}) AND ($2::int[] IS NULL OR id = ANY($2))
         RETURNING id, student_id`,
        [now, only, ...params]
    );
    if (updated.rows.length > 0) {
        await client.query(
            `INSERT INTO application_events (application_id, kind, actor_role, status, note, reason_code, created_at)
             SELECT unnest($1::int[]), 'auto_rejected', 'system', 'rejected', NULL, $2, $3`,
            [updated.rows.map((r) => r.id), reasonCode, now]
        );
    }
    return updated.rows;
};

const rejectAutomatically = async ({ now, notify = notifyStudent, only = null, condition, reasonCode }) => {
    const rows = await inTransaction((client) => rejectInTransaction(client, { now, condition, only, reasonCode }));
    await notifyEach(rows, notify, 'statusUpdate', () => ({ status: 'rejected', reasonCode }));
    return rows.length;
};

// No reply by the deadline: rejected with NO_INFO_RESPONSE
const rejectOverdueInfoRequests = ({ now, notify, only }) => rejectAutomatically({
    now, notify, only, reasonCode: 'NO_INFO_RESPONSE',
    condition: "status = 'needs_info' AND info_deadline <= $1",
});

// The semester end is no longer handled here: the admin closes the semester (utils/semesterClose.js)
// once everything is decided. The review deadline rejects nothing either (round 2 Group 1): the
// reviewers are reminded before it, the admins are told once after it (steps below).

/**
 * Unsent drafts (admin round Group 6): when the active semester's last-days warning starts, students
 * with an unsent draft get one email, "your draft hasn't been submitted; applications close on
 * <date>". Recorded before sending (draft_reminders), so it goes out once per student and semester.
 */
const remindUnsentDrafts = async ({ now, notify, onlyDraftsOf = null }) => {
    const { rows } = await pool.query(
        `INSERT INTO draft_reminders (semester_id, student_id, sent_at)
         SELECT sb.id, d.student_id, $1
         FROM semester_bounds sb
         JOIN application_drafts d ON true
         JOIN users u ON u.id = d.student_id AND u.role = 'student'
         WHERE sb.status = 'active' AND sb.last_days_from <= $1 AND sb.closes_at > $1
           AND ($2::int[] IS NULL OR d.student_id = ANY($2))
         ON CONFLICT (semester_id, student_id) DO NOTHING
         RETURNING semester_id, student_id, (SELECT closes_at FROM semester_bounds WHERE id = semester_id) AS closes_at`,
        [now, onlyDraftsOf]
    );
    await notifyEach(rows.map((r) => ({ ...r, id: `draft-${r.student_id}` })), notify, 'draftReminder', (r) => ({ deadline: r.closes_at }));
    return rows.length;
};

// The reviewer's review-deadline reminder email, in the reviewer's language. Never throws.
const remindReviewer = async (reminder) => {
    try {
        const email = buildReviewerEmail(reminder.kind === '1_day' ? 'reviewDeadlineTomorrow' : 'reviewDeadlineSoon', reminder.preferred_language, {
            name: reminder.reviewer_name,
            programme: reminder[`programme_${String(reminder.preferred_language || 'hu').slice(0, 2)}`] || reminder.programme_hu,
            deadline: reminder.review_ends_at,
            pending: reminder.pending_count,
            needsInfo: reminder.needs_info_count,
        });
        if (email) await sendEmail({ email: reminder.reviewer_email, subject: email.subject, html: email.html });
    } catch (err) {
        console.error(`❌ Review deadline reminder (${reminder.kind}) for programme ${reminder.programme_id} failed:`, err.message);
    }
};

/**
 * Reviewer reminders before the REVIEW DEADLINE (reviewer Group 7; round 2 Group 1: counted down to
 * the review deadline, not the semester's end). For each programme with undecided applications
 * (pending or needs_info) in a semester in progress, to EVERYONE who can see it (its main reviewer,
 * and extra reviewers while allowed to assist; utils/reviewers.js):
 *   7_days: from REVIEW_WARNING_DAYS (7) days before the review deadline
 *   1_day:  from 1 day before it, until the deadline
 * (Budapest wall clock, so a clock change never moves them by an hour.)
 * The reminder is recorded first (reviewer_reminders, one row per semester, programme, kind and reviewer);
 * only a run whose insert succeeded sends the email, so it goes out once, also with two processes.
 * A server that was off for the whole 7-day window sends only the 1-day reminder (no stale week
 * notice). With nothing undecided nothing is recorded, so a reminder still goes out if
 * applications arrive later in the window. Applications of no semester are never counted.
 */
const beforeDeadline = (days) => `((sb.review_ends_at AT TIME ZONE 'Europe/Budapest') - make_interval(days => ${days})) AT TIME ZONE 'Europe/Budapest'`;
const remindReviewersBeforeReviewDeadline = async ({ now, remind = remindReviewer, only = null }) => {
    const { rows } = await pool.query(
        `WITH due AS (
             SELECT sb.id AS semester_id, a.programme_id, r.id AS reviewer_id,
                    CASE WHEN ${beforeDeadline(1)} <= $1 THEN '1_day' ELSE '7_days' END AS kind,
                    count(*) FILTER (WHERE a.status = 'pending')::int AS pending_count,
                    count(*) FILTER (WHERE a.status = 'needs_info')::int AS needs_info_count
             FROM semester_bounds sb
             JOIN applications a ON a.semester_id = sb.id AND a.status IN ('pending', 'needs_info')
             JOIN staff_programmes sp ON sp.programme_id = a.programme_id AND ${seesProgrammeSql('sp')}
             JOIN users r ON r.id = sp.user_id AND r.deactivated_at IS NULL
             WHERE sb.status = 'active' AND ${beforeDeadline('$3::int')} <= $1 AND sb.review_ends_at > $1
               AND ($2::int[] IS NULL OR a.id = ANY($2))
             GROUP BY 1, 2, 3, 4
         ), recorded AS (
             INSERT INTO reviewer_reminders (semester_id, programme_id, kind, reviewer_id, pending_count, needs_info_count, sent_at)
             SELECT semester_id, programme_id, kind, reviewer_id, pending_count, needs_info_count, $1 FROM due
             ON CONFLICT (semester_id, programme_id, kind, reviewer_id) DO NOTHING
             RETURNING semester_id, programme_id, kind, reviewer_id, pending_count, needs_info_count
         )
         SELECT recorded.*, r.name AS reviewer_name, r.email AS reviewer_email, r.preferred_language,
                p.name_hu AS programme_hu, p.name_en AS programme_en, p.name_de AS programme_de,
                s.review_ends_at
         FROM recorded
         JOIN users r ON r.id = recorded.reviewer_id
         JOIN programmes p ON p.id = recorded.programme_id
         JOIN semester_bounds s ON s.id = recorded.semester_id`,
        [now, only, REVIEW_WARNING_DAYS]
    );
    for (const reminder of rows) {
        try {
            await remind(reminder);
        } catch (err) {
            console.error(`❌ Review deadline reminder (${reminder.kind}) for programme ${reminder.programme_id} failed:`, err.message);
        }
    }
    return rows.length;
};

// The reviewers' daily summary (round 2 Group 1): at this hour, Budapest time. The one place to change it.
const DAILY_SUMMARY_HOUR = 7;

// One reviewer's daily summary email, in their language. Never throws.
const sendReviewerSummary = async (summary) => {
    try {
        const email = buildReviewerSummaryEmail(summary.preferred_language, {
            name: summary.reviewer_name, newApplications: summary.newApplications, replies: summary.replies, changed: summary.changed || [], waiting: summary.waiting,
        });
        await sendEmail({ email: summary.reviewer_email, subject: email.subject, html: email.html });
    } catch (err) {
        console.error(`❌ Daily summary for reviewer ${summary.reviewer_id} failed:`, err.message);
    }
};

/**
 * The reviewers' daily summary (round 2 Group 1), instead of an email per new application and per
 * student reply. From DAILY_SUMMARY_HOUR (07:00) Budapest time, on the Budapest clock (a clock
 * change never moves it), each active reviewer who can see a programme gets one summary a day:
 *   - the first run at or after 07:00 records the day (reviewer_summaries; a run that finds it
 *     already recorded does nothing: never twice, also after a restart or with two processes)
 *     and covers everything since the previous summary (the first one: the last 24 hours);
 *   - what is new: applications submitted and student replies in the programmes the reviewer can
 *     see at that moment (main reviewer, or extra reviewer while allowed to assist), not withdrawn;
 *     and (round 2 Group 2) decisions the committee CHANGED there, with the final status (kept
 *     ones are not news; who in the committee acted is never said);
 *   - nothing new: recorded, no email (later news waits for the next day's summary).
 * A server that was off at 07:00 sends it at the next run the same day; off for days: the next
 * summary covers everything since the last one.
 */
const sendDailySummaries = async ({ now, summarize = sendReviewerSummary, onlyReviewers = null }) => {
    const { rows: recorded } = await pool.query(
        `WITH clock AS (SELECT ($1::timestamptz AT TIME ZONE 'Europe/Budapest') AS local),
         due AS (
             SELECT u.id AS reviewer_id FROM users u, clock
             WHERE u.role = 'reviewer' AND u.deactivated_at IS NULL
               AND clock.local::time >= make_time($3::int, 0, 0)
               AND ($2::int[] IS NULL OR u.id = ANY($2))
               AND EXISTS (SELECT 1 FROM staff_programmes sp WHERE sp.user_id = u.id AND ${seesProgrammeSql('sp')})
               AND NOT EXISTS (SELECT 1 FROM reviewer_summaries r WHERE r.reviewer_id = u.id AND r.day = clock.local::date)
         )
         INSERT INTO reviewer_summaries (reviewer_id, day, covered_from, covered_until)
         SELECT d.reviewer_id, (SELECT local::date FROM clock),
                LEAST(COALESCE((SELECT max(p.covered_until) FROM reviewer_summaries p WHERE p.reviewer_id = d.reviewer_id), $1 - interval '24 hours'), $1),
                $1
         FROM due d
         ON CONFLICT (reviewer_id, day) DO NOTHING
         RETURNING reviewer_id, day, covered_from, covered_until`,
        [now, onlyReviewers, DAILY_SUMMARY_HOUR]
    );
    let emailed = 0;
    for (const row of recorded) {
        const programmeIds = (await pool.query(
            `SELECT sp.programme_id FROM staff_programmes sp WHERE sp.user_id = $1 AND ${seesProgrammeSql('sp')}`, [row.reviewer_id]
        )).rows.map((r) => r.programme_id);
        const events = (await pool.query(
            `SELECT e.kind, e.status, s.name AS student, p.code AS programme,
                    a.target_course_code || COALESCE(' – ' || (a.target_courses->0->>'course_name'), '') AS course
             FROM application_events e
             JOIN applications a ON a.id = e.application_id
             JOIN users s ON s.id = a.student_id
             JOIN programmes p ON p.id = a.programme_id
             WHERE e.kind IN ('submitted', 'replied', 'committee_changed') AND e.created_at > $2 AND e.created_at <= $3
               AND a.programme_id = ANY($1) AND a.status <> 'withdrawn'
             ORDER BY e.created_at, e.id`,
            [programmeIds, row.covered_from, row.covered_until]
        )).rows;
        const newApplications = events.filter((e) => e.kind === 'submitted');
        const replies = events.filter((e) => e.kind === 'replied');
        const changed = events.filter((e) => e.kind === 'committee_changed');
        await pool.query(
            'UPDATE reviewer_summaries SET new_applications = $3, student_replies = $4, emailed = $5 WHERE reviewer_id = $1 AND day = $2',
            [row.reviewer_id, row.day, newApplications.length, replies.length, events.length > 0]
        );
        if (events.length === 0) continue;
        const reviewer = (await pool.query('SELECT name, email, preferred_language FROM users WHERE id = $1', [row.reviewer_id])).rows[0];
        const waiting = (await pool.query(
            `SELECT count(*)::int AS n FROM applications a
             WHERE a.programme_id = ANY($1) AND a.status = 'pending'
               AND NOT EXISTS (SELECT 1 FROM semesters c WHERE c.id = a.semester_id AND c.status = 'closed')`,
            [programmeIds]
        )).rows[0].n;
        try {
            await summarize({
                reviewer_id: row.reviewer_id, reviewer_name: reviewer.name, reviewer_email: reviewer.email, preferred_language: reviewer.preferred_language,
                day: row.day, newApplications, replies, changed, waiting,
            });
            emailed += 1;
        } catch (err) {
            console.error(`❌ Daily summary for reviewer ${row.reviewer_id} failed:`, err.message);
        }
    }
    return emailed;
};

// The admins' "review deadline passed" email: every active admin, in their language. Never throws.
const alertAdmins = async (alert) => {
    try {
        const { rows: admins } = await pool.query(
            "SELECT name, email, preferred_language FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL ORDER BY id"
        );
        for (const admin of admins) {
            const lang = String(admin.preferred_language || 'hu').slice(0, 2);
            const email = buildAdminEmail('reviewDeadlinePassed', admin.preferred_language, {
                name: admin.name, semester: alert.semester_name, deadline: alert.review_ends_at,
                programmes: alert.programmes.map((p) => ({ name: `${p.code} – ${p[`name_${lang}`] || p.name_en}`, pending: p.pending, needsInfo: p.needs_info })),
            });
            if (email) await sendEmail({ email: admin.email, subject: email.subject, html: email.html });
        }
    } catch (err) {
        console.error(`❌ Review deadline email for semester ${alert.semester_id} failed:`, err.message);
    }
};

/**
 * The review deadline has passed and applications are still pending or in needs info (round 2
 * Group 1): NOTHING is rejected. The admins get one email per semester, with the undecided counts
 * per programme (the Overview shows them too). Recorded first (review_deadline_alerts), so it goes
 * out once, also after a restart or with two processes. With nothing undecided nothing is sent.
 */
const alertReviewDeadlinePassed = async ({ now, alert = alertAdmins, only = null }) => {
    const { rows } = await pool.query(
        `WITH due AS (
             SELECT sb.id AS semester_id,
                    count(*) FILTER (WHERE a.status = 'pending')::int AS pending_count,
                    count(*) FILTER (WHERE a.status = 'needs_info')::int AS needs_info_count
             FROM semester_bounds sb
             JOIN applications a ON a.semester_id = sb.id AND a.status IN ('pending', 'needs_info')
             WHERE sb.status = 'active' AND sb.review_ends_at <= $1 AND ($2::int[] IS NULL OR a.id = ANY($2))
             GROUP BY 1
         ), recorded AS (
             INSERT INTO review_deadline_alerts (semester_id, pending_count, needs_info_count, sent_at)
             SELECT semester_id, pending_count, needs_info_count, $1 FROM due
             ON CONFLICT (semester_id) DO NOTHING
             RETURNING semester_id, pending_count, needs_info_count
         )
         SELECT recorded.*, sb.name AS semester_name, sb.review_ends_at FROM recorded JOIN semester_bounds sb ON sb.id = recorded.semester_id`,
        [now, only]
    );
    for (const row of rows) {
        const programmes = (await pool.query(
            `SELECT p.code, p.name_en, p.name_hu, p.name_de,
                    count(*) FILTER (WHERE a.status = 'pending')::int AS pending,
                    count(*) FILTER (WHERE a.status = 'needs_info')::int AS needs_info
             FROM applications a JOIN programmes p ON p.id = a.programme_id
             WHERE a.semester_id = $1 AND a.status IN ('pending', 'needs_info') AND ($2::int[] IS NULL OR a.id = ANY($2))
             GROUP BY p.id ORDER BY p.code`,
            [row.semester_id, only]
        )).rows;
        try {
            await alert({ ...row, programmes });
        } catch (err) {
            console.error(`❌ Review deadline email for semester ${row.semester_id} failed:`, err.message);
        }
    }
    return rows.length;
};

// The steps of one run, in order. Each is independent; a failing one never stops the others.
const STEPS = [
    ['unsent draft reminders', remindUnsentDrafts],
    ['reviewer daily summaries', sendDailySummaries],
    ['reviewer reminders', remindReviewersBeforeReviewDeadline],
    ['review deadline passed', alertReviewDeadlinePassed],
    ['deadline reminders', sendDeadlineReminders],
    ['overdue information requests', rejectOverdueInfoRequests],
];

/**
 * One run of every step. A failing step is logged and the next one still runs.
 * @returns {Promise<Record<string, number|string>>} what each step did (count, or 'failed')
 */
const runApplicationJobs = async ({
    now = new Date(), notify = notifyStudent, remind = remindReviewer, alert = alertAdmins, summarize = sendReviewerSummary,
    only = null, onlyDraftsOf = null, onlyReviewers = null,
} = {}) => {
    const results = {};
    // A run limited to some applications (the tests) never summarises real reviewers: only the named ones
    const reviewers = only !== null && onlyReviewers === null ? [] : onlyReviewers;
    for (const [name, step] of STEPS) {
        try {
            results[name] = await step({ now, notify, remind, alert, summarize, only, onlyDraftsOf, onlyReviewers: reviewers });
            if (results[name] > 0) console.log(`⏱️  Background job, ${name}: ${results[name]}`);
        } catch (err) {
            results[name] = 'failed';
            console.error(`❌ Background job, ${name} failed:`, err.message);
        }
    }
    return results;
};

// Only one run at a time across ALL backend processes and `npm run jobs:run`: a Postgres advisory
// lock, held by one connection for the whole run. A run that can't get it skips its turn (the
// other run is doing the work). The conditional updates above stay as a second safety net.
const JOBS_LOCK_KEY = 2026_0712; // any fixed number, used only for this lock

/**
 * Runs `work` only if no other process is running the jobs right now.
 * @returns {Promise<{ skipped: true } | { skipped: false, result: any }>}
 */
const withJobsLock = async (work) => {
    const client = await pool.connect();
    try {
        const { got } = (await client.query('SELECT pg_try_advisory_lock($1) AS got', [JOBS_LOCK_KEY])).rows[0];
        if (!got) return { skipped: true };
        try {
            return { skipped: false, result: await work() };
        } finally {
            await client.query('SELECT pg_advisory_unlock($1)', [JOBS_LOCK_KEY]).catch(() => {});
        }
    } finally {
        client.release();
    }
};

module.exports = {
    runApplicationJobs, withJobsLock, JOBS_LOCK_KEY, sendDeadlineReminders, rejectOverdueInfoRequests, remindUnsentDrafts,
    remindReviewersBeforeReviewDeadline, remindReviewer, alertReviewDeadlinePassed, alertAdmins, sendDailySummaries, sendReviewerSummary,
    DAILY_SUMMARY_HOUR, rejectAutomatically, rejectInTransaction, notifyEach, REJECTION_REASONS,
};
