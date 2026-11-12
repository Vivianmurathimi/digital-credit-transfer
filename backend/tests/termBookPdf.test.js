/**
 * The PDF book's decision line (utils/buildTermBookPdf.js, admin round Group 7):
 *
 *   npm test
 *
 * Builds a book from made-up data (no database, no files) and checks that EVERY page of every
 * application carries the decision line, also when an application runs over several pages.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const buildTermBookPdf = require('../utils/buildTermBookPdf');

const application = (id, extra = {}) => ({
    id, status: 'approved', notReviewedBySemesterEnd: false, submittedAt: new Date('2097-03-02T09:00:00Z'), reviewedAt: null,
    student: { name: `Student ${id}`, email: `s${id}@students.example` }, reviewer: null,
    decision: { finalGrade: 4, decidedBy: 'Dr. Example', decidedAt: new Date('2097-03-04T09:00:00Z'), rationale: null, reasonCode: null },
    courses: [], pteCourses: ['CS101 (Intro)'], notes: { student: null, system: null, reviewer: null, resubmit: null }, evidence: [], ...extra,
});

test('every page of every application has the decision line', async () => {
    const long = 'A long note. '.repeat(600); // runs over several pages
    const data = {
        from: '2097-03-01', to: '2097-06-30', label: 'Test semester', generatedAt: new Date(), total: 3,
        totals: { pending: 0, needs_info: 0, approved: 1, rejected: 2, withdrawn: 0 },
        applications: [
            application(1),
            application(2, { status: 'rejected', notes: { student: long, system: null, reviewer: null, resubmit: null }, decision: { finalGrade: null, decidedBy: 'Admin', decidedAt: new Date(), rationale: 'Different content', reasonCode: null } }),
            application(3, { status: 'rejected', notReviewedBySemesterEnd: true, decision: { finalGrade: null, decidedBy: 'System', decidedAt: new Date(), rationale: null, reasonCode: 'SEMESTER_ENDED' } }),
        ],
    };
    const { buffer, pages, decisionLinePages, firstApplicationPage } = await buildTermBookPdf(data);
    assert.ok(buffer.length > 1000 && buffer.subarray(0, 4).toString() === '%PDF');
    assert.ok(pages - firstApplicationPage > 3, 'the long application runs over more than one page');
    assert.equal(decisionLinePages, pages - firstApplicationPage, 'every page from the first application on has the line');
});

// Round 2 Group 1: a reviewer's interim book and one application's PDF
const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

test("a reviewer's book: the programmes and INTERIM on the cover, the same application pages", async () => {
    const base = {
        from: '2097-03-01', to: '2097-06-30', label: 'Test semester', generatedAt: new Date(), total: 1,
        totals: { pending: 1, needs_info: 0, approved: 0, rejected: 0, withdrawn: 0 },
        applications: [application(1, { status: 'pending', decision: null })],
    };
    const plain = await buildTermBookPdf(base);
    const interim = await buildTermBookPdf({ ...base, programmes: ['CS', 'CIVIL'], interim: true });
    assert.equal(interim.pages, plain.pages, 'same pages: cover, index, the application');
    assert.equal(interim.firstApplicationPage, plain.firstApplicationPage);
    assert.equal(interim.decisionLinePages, plain.decisionLinePages);
    assert.ok(interim.buffer.length > plain.buffer.length, 'the interim marking and the programmes are added');
});

test("one application's PDF: no cover, no index, every page with the decision line", async () => {
    const long = 'A long note. '.repeat(600);
    const data = {
        from: '2097-03-01', to: '2097-06-30', label: 'Test semester', generatedAt: new Date(), total: 1, single: true, interim: false,
        totals: { pending: 0, needs_info: 0, approved: 1, rejected: 0, withdrawn: 0 },
        applications: [application(7, { notes: { student: long, system: null, reviewer: null, resubmit: null } })],
    };
    const { buffer, pages, decisionLinePages, firstApplicationPage } = await buildTermBookPdf(data);
    assert.equal(firstApplicationPage, 0, 'it starts on the first page');
    assert.ok(pages > 1, 'a long application runs over several pages');
    assert.equal(decisionLinePages, pages, 'every page has the decision line');
    assert.equal(pageCount(buffer), pages);
});
