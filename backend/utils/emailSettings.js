// The daily summary emails each person can switch off (professor's review notes; migration 031).
// Only the two daily summaries: deadline reminders, the admins' alerts, invites, account emails and
// every student email are always sent, so they have no switch.
//
// Which switches apply to someone follows the same rules as the summary jobs (jobs/applicationJobs.js):
//   reviewerSummary    an account with the role reviewer (the reviewers' summary goes to reviewers)
//   committeeSummary   someone on a committee now (CURRENT_MEMBER_SQL: a current committee link of an
//                      active committee member or reviewer), or a committee account without a
//                      current link (the switch is theirs, it just has nothing to send yet)
// Students and admins have none.

const { CURRENT_MEMBER_SQL } = require('./committee');

const SWITCHES = {
    reviewerSummary: 'reviewer_summary_email',
    committeeSummary: 'committee_summary_email',
};

const problem = (field, code, message) => ({ field, code, message });

/**
 * The switches that apply to this user, with their values: { reviewerSummary?, committeeSummary? }.
 * null when the account doesn't exist.
 */
const emailSettingsOf = async (db, userId) => {
    const row = (await db.query(
        `SELECT u.role, u.reviewer_summary_email, u.committee_summary_email,
                EXISTS (SELECT 1 FROM staff_programmes cl WHERE cl.user_id = u.id AND ${CURRENT_MEMBER_SQL('cl', 'u')}) AS on_committee
         FROM users u WHERE u.id = $1`,
        [userId]
    )).rows[0];
    if (!row) return null;
    const settings = {};
    if (row.role === 'reviewer') settings.reviewerSummary = row.reviewer_summary_email;
    if (row.role === 'committee' || row.on_committee) settings.committeeSummary = row.committee_summary_email;
    return settings;
};

/**
 * Checks a change against the switches that apply: { errors } or { changes: { column: boolean } }.
 * At least one switch; each one a boolean and one of the user's own.
 */
const checkEmailSettingsChange = (body, applicable) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
        return { errors: [problem('settings', 'INVALID_EMAIL_SETTINGS', 'Send at least one switch: reviewerSummary or committeeSummary')] };
    }
    const errors = [];
    const changes = {};
    for (const [key, value] of Object.entries(body)) {
        if (!(key in SWITCHES)) errors.push(problem(key, 'INVALID_EMAIL_SETTINGS', 'Unknown switch'));
        else if (typeof value !== 'boolean') errors.push(problem(key, 'INVALID_EMAIL_SETTINGS', 'A switch is true or false'));
        else if (!(key in applicable)) errors.push(problem(key, 'EMAIL_SETTING_NOT_YOURS', 'This email is not sent to you, so it has no switch'));
        else changes[SWITCHES[key]] = value;
    }
    return errors.length ? { errors } : { changes };
};

// Saves checked changes (only the columns from checkEmailSettingsChange)
const saveEmailSettings = async (db, userId, changes) => {
    const columns = Object.keys(changes);
    await db.query(
        `UPDATE users SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [userId, ...columns.map((column) => changes[column])]
    );
};

module.exports = { SWITCHES, emailSettingsOf, checkEmailSettingsChange, saveEmailSettings };
