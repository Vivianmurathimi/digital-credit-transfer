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
