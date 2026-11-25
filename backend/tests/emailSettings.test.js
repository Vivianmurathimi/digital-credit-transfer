/**
 * Who can switch off which daily summary email (migration 031, utils/emailSettings.js):   npm test
 *
 * The rules the GET and PUT /api/me/email-settings routes use, on temporary accounts
 * (@email-settings-test.invalid) and a temporary programme ZQE…; all deleted afterwards. The routes
 * themselves (own settings only, acting refused with 403) are checked over HTTP by the security check (4ah).
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { emailSettingsOf, checkEmailSettingsChange, saveEmailSettings } = require('../utils/emailSettings');

const run = Date.now().toString(36).toUpperCase();
let programmeId;
const people = {};

const account = async (key, role, links = []) => {
    const user = (await pool.query(
        "INSERT INTO users (name, email, password, role, is_verified) VALUES ($1, $2, 'not-a-password-hash', $3, true) RETURNING id",
        [`Email settings ${key}`, `${key}-${run.toLowerCase()}@email-settings-test.invalid`, role]
    )).rows[0];
    for (const [linkRole, ended] of links) {
        await pool.query('INSERT INTO staff_programmes (user_id, programme_id, role, ended_at) VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END)', [user.id, programmeId, linkRole, ended]);
    }
    return user.id;
};

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    programmeId = (await pool.query(
        "INSERT INTO programmes (code, name_hu, name_en, name_de) VALUES ($1, 'Zqe', 'Zqe', 'Zqe') RETURNING id", [`ZQE${run}`.slice(0, 20)]
    )).rows[0].id;
    people.reviewer = await account('reviewer', 'reviewer', [['main', false]]);
    people.both = await account('both', 'reviewer', [['extra', false], ['committee', false]]);
    people.formerMember = await account('former', 'reviewer', [['extra', false], ['committee', true]]);
    people.member = await account('member', 'committee', [['committee', false]]);
    people.admin = await account('admin', 'superadmin');
    people.student = (await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
         VALUES ('Email settings student', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id`,
        [`student-${run.toLowerCase()}@email-settings-test.invalid`, `E${run.slice(-5)}`.padEnd(6, 'E').slice(0, 6), programmeId]
    )).rows[0].id;
});

after(async () => {
    await pool.query("DELETE FROM users WHERE email LIKE '%@email-settings-test.invalid'"); // their links go with them
    await pool.query('DELETE FROM programmes WHERE id = $1', [programmeId]);
    await pool.end();
});

test('each person gets only the switches that apply to them, on by default', async () => {
    assert.deepEqual(await emailSettingsOf(pool, people.reviewer), { reviewerSummary: true }, 'a reviewer: the reviewer summary');
    assert.deepEqual(await emailSettingsOf(pool, people.both), { reviewerSummary: true, committeeSummary: true }, 'a reviewer on a committee: both');
    assert.deepEqual(await emailSettingsOf(pool, people.formerMember), { reviewerSummary: true }, 'an ended committee link: the reviewer one only');
    assert.deepEqual(await emailSettingsOf(pool, people.member), { committeeSummary: true }, 'a committee member: the committee summary');
    assert.deepEqual(await emailSettingsOf(pool, people.admin), {}, 'admins: none (their alerts always come)');
    assert.deepEqual(await emailSettingsOf(pool, people.student), {}, 'students: none');
    assert.equal(await emailSettingsOf(pool, 2147483000), null, 'no such account');
});

test('a change: only booleans, only your own switches, at least one', async () => {
    const reviewerSide = { reviewerSummary: true };
    const codeOf = (body, applicable = reviewerSide) => checkEmailSettingsChange(body, applicable).errors?.[0]?.code;
    assert.equal(codeOf({}), 'INVALID_EMAIL_SETTINGS', 'empty');
    assert.equal(codeOf(null), 'INVALID_EMAIL_SETTINGS');
    assert.equal(codeOf([true]), 'INVALID_EMAIL_SETTINGS', 'a list');
    assert.equal(codeOf({ reviewerSummary: 'false' }), 'INVALID_EMAIL_SETTINGS', 'a string, not a boolean');
    assert.equal(codeOf({ reviewerSummary: 0 }), 'INVALID_EMAIL_SETTINGS', 'a number');
    assert.equal(codeOf({ deadlineReminders: false }), 'INVALID_EMAIL_SETTINGS', 'reminders have no switch');
    assert.equal(codeOf({ committeeSummary: false }), 'EMAIL_SETTING_NOT_YOURS', "a reviewer without a committee: not theirs");
    assert.equal(codeOf({ reviewerSummary: false }, {}), 'EMAIL_SETTING_NOT_YOURS', 'a student or an admin: nothing is theirs');
    assert.deepEqual(checkEmailSettingsChange({ reviewerSummary: false }, reviewerSide), { changes: { reviewer_summary_email: false } });
});

test('saving changes only that person, only the switch sent', async () => {
    const { changes } = checkEmailSettingsChange({ committeeSummary: false }, await emailSettingsOf(pool, people.both));
    await saveEmailSettings(pool, people.both, changes);
    assert.deepEqual(await emailSettingsOf(pool, people.both), { reviewerSummary: true, committeeSummary: false });
    assert.deepEqual(await emailSettingsOf(pool, people.member), { committeeSummary: true }, 'nobody else changed');
    await saveEmailSettings(pool, people.both, checkEmailSettingsChange({ committeeSummary: true, reviewerSummary: false }, await emailSettingsOf(pool, people.both)).changes);
    assert.deepEqual(await emailSettingsOf(pool, people.both), { reviewerSummary: false, committeeSummary: true }, 'both at once');
});
