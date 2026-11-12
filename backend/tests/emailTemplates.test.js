/**
 * The decision and reviewer emails (reviewer Group 6), built without sending anything:   npm test
 * No database, mail server or network is needed.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.FRONTEND_URL ||= 'http://localhost:3000';
require('dotenv').config();

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEmail, buildReviewerEmail, buildReviewerSummaryEmail, buildAdminEmail, gradeLabel } = require('../utils/emailTemplates');

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

test("reviewers' daily summary: new applications and replies, the waiting count, in every language, escaped", () => {
    const item = { student: 'Kovács <Ödön>', course: 'IVM123 – Statika', programme: 'CIVIL' };
    for (const lang of LANGUAGES) {
        const email = buildReviewerSummaryEmail(lang, { name: 'Dr. Nagy', newApplications: [item, item], replies: [item], waiting: 5 });
        assert.ok(email && email.subject, `${lang}: subject`);
        assert.ok(email.html.includes('Kovács &lt;Ödön&gt;') && email.html.includes('IVM123 – Statika') && email.html.includes('(CIVIL)'), `${lang}: student, course, programme`);
        assert.ok(email.html.includes('(2)') && email.html.includes('(1)') && email.html.includes('<strong>5</strong>'), `${lang}: counts`);
        assert.ok(email.html.includes('/login'), `${lang}: login link`);
    }
    const many = buildReviewerSummaryEmail('en', { name: 'x', newApplications: Array(35).fill(item), replies: [], waiting: 0 });
    assert.ok(many.html.includes('and 5 more'), 'long lists are cut');
    // No email per new application or reply any more (round 2 Group 1)
    assert.equal(buildReviewerEmail('newApplication', 'en', { name: 'x' }), null);
    assert.equal(buildReviewerEmail('nothing', 'en', { name: 'x' }), null);
});

test('reviewer review-deadline reminders: both numbers, the deadline in Budapest time, in every language, escaped', () => {
    const deadline = new Date('2027-01-31T22:59:00Z'); // 23:59 in Budapest
    for (const lang of LANGUAGES) {
        for (const type of ['reviewDeadlineSoon', 'reviewDeadlineTomorrow']) {
            const email = buildReviewerEmail(type, lang, { name: 'Dr. Nagy', programme: 'Civil <Engineering>', deadline, pending: 4, needsInfo: 1 });
            assert.ok(email && email.subject, `${lang} ${type}: subject`);
            assert.ok(email.html.includes('Civil &lt;Engineering&gt;'), `${lang} ${type}: programme escaped`);
            assert.ok(email.html.includes('<strong>4</strong>') && email.html.includes('<strong>1</strong>'), `${lang} ${type}: both numbers`);
            assert.ok(/31/.test(email.html) && /2027/.test(email.html) && /23[:.]59/.test(email.html), `${lang} ${type}: the deadline in Budapest time`);
        }
    }
    assert.notEqual(buildReviewerEmail('reviewDeadlineSoon', 'en', { name: 'x' }).subject, buildReviewerEmail('reviewDeadlineTomorrow', 'en', { name: 'x' }).subject);
    assert.equal(buildReviewerEmail('counts', 'en', { name: 'x' }), null, 'a word list is not an email');
});

test("admins' review deadline email: every programme with both numbers, escaped, in every language", () => {
    for (const lang of LANGUAGES) {
        const email = buildAdminEmail('reviewDeadlinePassed', lang, {
            name: 'Admin', semester: 'Autumn <2027>', deadline: new Date('2027-01-31T22:59:00Z'),
            programmes: [{ name: 'CS – Computer <Science>', pending: 3, needsInfo: 2 }, { name: 'CE – Civil', pending: 0, needsInfo: 1 }],
        });
        assert.ok(email && email.subject, `${lang}: subject`);
        assert.ok(email.html.includes('Autumn &lt;2027&gt;') && email.html.includes('Computer &lt;Science&gt;'), `${lang}: escaped`);
        assert.ok(email.html.includes(' 3 ') && email.html.includes(' 2 ') && email.html.includes('CE – Civil'), `${lang}: every programme and number`);
    }
    assert.ok(buildAdminEmail('noMainReviewer', 'en', { name: 'A', programme: 'CS', extras: 'B' }).html.includes('CS'));
    assert.equal(buildAdminEmail('nothing', 'en', { name: 'x' }), null);
});
