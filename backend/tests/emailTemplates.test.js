/**
 * The decision and reviewer emails (reviewer Group 6), built without sending anything:   npm test
 * No database, mail server or network is needed.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.FRONTEND_URL ||= 'http://localhost:3000';
require('dotenv').config();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEmail, buildReviewerEmail, gradeLabel } = require('../utils/emailTemplates');

const LANGUAGES = ['hu', 'en', 'de'];

test('the grade is always shown with its Hungarian name', () => {
    assert.equal(gradeLabel(4, 'hu'), '4 (jó)');
    assert.equal(gradeLabel(4, 'en'), '4 (jó – good)');
    assert.equal(gradeLabel(5, 'de'), '5 (jeles – sehr gut)');
    assert.equal(gradeLabel(2, 'en'), '2 (elégséges – pass)');
});

test('the approval email carries the final grade (and the note, if any) in every language', () => {
    for (const lang of LANGUAGES) {
        const { html } = buildEmail('statusUpdate', lang, { name: 'Anna', status: 'approved', finalGrade: 4, note: 'Well documented.' });
        assert.ok(html.includes(gradeLabel(4, lang)), `${lang}: grade`);
        assert.ok(html.includes('Well documented.'), `${lang}: note`);
    }
    const withoutNote = buildEmail('statusUpdate', 'en', { name: 'Anna', status: 'approved', finalGrade: 3 });
    assert.ok(withoutNote.html.includes('3 (közepes – satisfactory)') && !withoutNote.html.includes("Reviewer's message"));
});

test('the rejection email carries the rationale as the reason, escaped', () => {
    for (const lang of LANGUAGES) {
        const { html } = buildEmail('statusUpdate', lang, { name: 'Anna', status: 'rejected', note: 'Content <differs>' });
        assert.ok(html.includes('Content &lt;differs&gt;'), `${lang}: rationale escaped`);
    }
    assert.ok(buildEmail('statusUpdate', 'en', { name: 'A', status: 'rejected', note: 'x' }).html.includes('Reason:'));
});

test('the request-for-information email says by when to reply', () => {
    const deadline = new Date('2026-11-10T22:59:59Z'); // 23:59:59 on 10 November in Budapest
    for (const lang of LANGUAGES) {
        const { html } = buildEmail('needsInfo', lang, { name: 'Anna', note: 'Send the syllabus.', deadline });
        assert.ok(html.includes('Send the syllabus.') && /10/.test(html) && /23:59/.test(html), `${lang}: message and deadline`);
    }
});

test('reviewer emails: new application and student reply, in every language, escaped', () => {
    for (const lang of LANGUAGES) {
        for (const type of ['newApplication', 'studentReplied']) {
            const email = buildReviewerEmail(type, lang, { name: 'Dr. Nagy', student: 'Kovács <Ödön>', course: 'IVM123 – Statika' });
            assert.ok(email && email.subject, `${lang} ${type}: subject`);
            assert.ok(email.html.includes('Kovács &lt;Ödön&gt;') && email.html.includes('IVM123 – Statika'), `${lang} ${type}: student and course`);
            assert.ok(email.html.includes('/login'), `${lang} ${type}: login link`);
        }
    }
    assert.equal(buildReviewerEmail('nothing', 'en', { name: 'x' }), null);
});

test('reviewer semester-end reminders: both numbers, the last day as a date, in every language, escaped', () => {
    for (const lang of LANGUAGES) {
        for (const type of ['semesterEndsSoon', 'semesterEndsToday']) {
            const email = buildReviewerEmail(type, lang, { name: 'Dr. Nagy', programme: 'Civil <Engineering>', endsOn: '2027-01-31', pending: 4, needsInfo: 1 });
            assert.ok(email && email.subject, `${lang} ${type}: subject`);
            assert.ok(email.html.includes('Civil &lt;Engineering&gt;'), `${lang} ${type}: programme escaped`);
            assert.ok(email.html.includes('<strong>4</strong>') && email.html.includes('<strong>1</strong>'), `${lang} ${type}: both numbers`);
            assert.ok(/31/.test(email.html) && /2027/.test(email.html), `${lang} ${type}: the date`);
        }
    }
    assert.ok(buildReviewerEmail('semesterEndsSoon', 'en', { name: 'x', programme: 'P', endsOn: '2027-01-31', pending: 0, needsInfo: 0 }).html.includes('31 January 2027'));
    assert.notEqual(buildReviewerEmail('semesterEndsSoon', 'en', { name: 'x' }).subject, buildReviewerEmail('semesterEndsToday', 'en', { name: 'x' }).subject);
    assert.equal(buildReviewerEmail('counts', 'en', { name: 'x' }), null, 'a word list is not an email');
});
