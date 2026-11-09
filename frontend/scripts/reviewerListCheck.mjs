/**
 * Checks the reviewer dashboard's list rules (reviewer Group 3):   npm run check:reviewer-list
 *
 * src/reviewerList.js splits the backend's list into tabs, searches it (no case, no accents) and
 * sorts it. Which applications are listed at all is decided by the backend (security check 4g).
 * No server, database or browser is needed.
 */
import * as list from '../src/reviewerList.js';
import * as grades from '../src/grades.js';

let failed = 0;
const report = (ok, name, detail = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let nextId = 1;
const app = (o = {}) => ({
    id: nextId++, status: 'pending', student_id: 1, semester_id: 10, student_name: 'Kovács Ödön', neptun_code: 'ABC123',
    target_course_code: 'IVM123', target_courses: [{ course_code: 'IVM123', course_name: 'Szilárdságtan', credits: 5 }],
    fulfilled_courses_json: [{ course_name: 'Technische Mechanik II', credits: 6 }], last_action_at: '2026-11-01T10:00:00Z', ...o,
});

// Folding
report(list.foldText('Kovács Ödön') === 'kovacs odon', 'Accents and case are ignored', list.foldText('Kovács Ödön'));
report(list.foldText('Őry Űrsula') === 'ory ursula', 'Hungarian ő and ű fold to o and u', list.foldText('Őry Űrsula'));
report(list.foldText('Straße') === 'strasse', 'German ß folds to ss', list.foldText('Straße'));
report(list.foldText(null) === '' && list.foldText(undefined) === '', 'Missing values are empty text');

// Search: every field, every word, no accents needed
const a = app();
const cases = [
    ['kovacs', true, 'student name without accents'], ['KOVÁCS', true, 'student name in capitals'], ['odon kovacs', true, 'words in any order'],
    ['abc123', true, 'Neptun code'], ['ivm123', true, 'target course code'], ['szilardsagtan', true, 'target course name'],
    ['mechanik', true, 'fulfilled course name'], ['   ', true, 'empty search shows everything'],
    ['nagy', false, 'another name'], ['kovacs nagy', false, 'every word must match'],
];
for (const [query, expected, what] of cases) report(list.matchesSearch(a, query) === expected, `Search "${query}": ${what}`, `${list.matchesSearch(a, query)}`);
report(list.matchesSearch(app({ fulfilled_courses_json: JSON.stringify([{ course_name: 'Statik' }]) }), 'statik'), 'Fulfilled courses stored as a JSON string are searched too');

// Tabs
report(['pending', 'needs_info', 'approved', 'rejected', 'withdrawn'].map((status) => list.tabOf({ status })).join() === 'pending,needs_info,completed,completed,',
    'Tabs: approved and rejected are Completed, withdrawn is in none');

// Sorting: oldest last action first; equal times by id
const older = app({ last_action_at: '2026-10-01T10:00:00Z' });
const newer = app({ last_action_at: '2026-11-05T10:00:00Z' });
const sameTime = app({ last_action_at: '2026-10-01T10:00:00Z' });
report(same(list.sortByLastAction([newer, sameTime, older]).map((x) => x.id), [older.id, sameTime.id, newer.id]), 'Oldest last action first (resubmission counts as the last action)');

// rowsFor / countsFor with the student filter: one student, one semester
const apps = [
    app({ id: 101, student_id: 1, semester_id: 10 }),
    app({ id: 102, student_id: 1, semester_id: 10, status: 'needs_info' }),
    app({ id: 103, student_id: 1, semester_id: 10, status: 'approved' }),
    app({ id: 104, student_id: 2, semester_id: 10, student_name: 'Nagy Anna' }),
    app({ id: 105, student_id: 1, semester_id: null }),
    app({ id: 106, student_id: 1, semester_id: 10, status: 'withdrawn' }),
];
const student = { studentId: 1, semesterId: 10 };
report(same(list.countsFor(apps, {}), { pending: 3, needs_info: 1, completed: 1 }), 'Counts per tab, withdrawn not counted', JSON.stringify(list.countsFor(apps, {})));
report(same(list.countsFor(apps, { student }), { pending: 1, needs_info: 1, completed: 1 }), 'Student filter: only that student in that semester', JSON.stringify(list.countsFor(apps, { student })));
report(same(list.rowsFor(apps, { tab: 'pending', query: 'anna' }).map((x) => x.id), [104]), 'Search inside a tab');
report(list.targetCourse(app({ target_courses: null, target_course_code: 'OLD1' })).course_code === 'OLD1', 'Old rows without a target snapshot show the course code');

// The list sends only the fulfilled course names
report(list.matchesSearch(app({ fulfilled_courses_json: undefined, fulfilled_course_names: ['Werkstoffkunde'] }), 'werkstoff'), 'Search uses the list\'s fulfilled_course_names');

// Credit comparison (reviewer Group 4)
const ects = (credits) => ({ credits, credit_system: 'ECTS' });
const enough = list.creditComparison([ects(3), ects(2.5)], 5);
report(enough.mode === 'ects' && enough.total === 5.5 && enough.required === 5 && enough.enough === true, 'All ECTS: 3 + 2.5 = 5.5 of 5 required is enough', JSON.stringify(enough));
const exact = list.creditComparison([ects(0.1), ects(0.2)], 0.3);
report(exact.total === 0.3 && exact.enough === true, 'Decimals add up exactly (0.1 + 0.2 = 0.3)', `${exact.total}`);
const short = list.creditComparison([ects('2'), ects('2')], 5);
report(short.total === 4 && short.enough === false, 'All ECTS: 4 of 5 is not enough (credits sent as text too)', JSON.stringify(short));
report(list.creditComparison([ects(5), { credits: 3, credit_system: 'US_CREDIT_HOURS' }], 5).mode === 'manual', 'ECTS mixed with US credit hours: compare manually');
report(list.creditComparison([{ credits: 10, credit_system: 'OTHER', credit_system_other: 'Local' }], 5).mode === 'manual', 'Another credit system: compare manually');
report(list.creditComparison([], 5).mode === 'manual', 'No fulfilled courses: nothing to add up');
report(list.creditComparison([ects(5)], null).enough === null, 'Target course without credits: no enough/not enough verdict');

// Notes and history (reviewer Group 5)
const ev = (o) => ({ files: [], note: null, note_type: null, actor_name: null, ...o });
const events = [
    ev({ id: 3, kind: 'replied', actor_role: 'student', actor_name: 'Kovács Ödön', note: 'Here it is', note_type: 'resubmit', created_at: '2026-11-03T10:00:00Z' }),
    ev({ id: 1, kind: 'submitted', actor_role: 'student', actor_name: 'Kovács Ödön', note: 'Please check', note_type: 'student', created_at: '2026-11-01T10:00:00Z' }),
    ev({ id: 2, kind: 'info_requested', actor_role: 'reviewer', actor_name: 'Dr. Nagy', note: 'Send the syllabus', note_type: 'reviewer', created_at: '2026-11-02T10:00:00Z' }),
    ev({ id: 5, kind: 'replied', actor_role: 'student', actor_name: 'Kovács Ödön', files: ['a.pdf'], created_at: '2026-11-04T10:00:00Z' }),
    ev({ id: 4, kind: 'replied', actor_role: 'student', actor_name: 'Kovács Ödön', created_at: '2026-11-04T10:00:00Z' }),
    ev({ id: 6, kind: 'auto_rejected', actor_role: 'system', note: 'No response to information request.', note_type: 'system', reason_code: 'NO_INFO_RESPONSE', created_at: '2026-11-08T10:00:00Z' }),
    ev({ id: 7, kind: 'decided', actor_role: 'admin', actor_name: 'Test Admin', status: 'pending', created_at: '2026-11-09T10:00:00Z' }),
];
report(same(list.sortEvents(events).map((e) => e.id), [1, 2, 3, 4, 5, 6, 7]), 'History: oldest first, same moment by id');
const talk = list.conversationOf(events);
report(same(talk.map((e) => e.id), [1, 2, 3, 5, 6]), 'Conversation: notes in time order, a files-only reply included, steps without a note left out', talk.map((e) => e.id).join(','));
report(same(talk.map((e) => e.boxType), ['student', 'reviewer', 'resubmit', 'resubmit', 'system']), 'Each note keeps its own box type', talk.map((e) => e.boxType).join(','));
report(same(list.authorOf(events[2]), { name: 'Dr. Nagy' }) && same(list.authorOf(events[6]), { labelKey: 'reviewer_author_admin' })
    && same(list.authorOf(events[5]), { labelKey: 'reviewer_author_system' }), 'Author: the name, or Admin / System (never the admin\'s name)');
report(same(list.authorOf(ev({ actor_role: 'reviewer' })), { labelKey: 'reviewer_author_reviewer' }), 'Author of a deleted account: only the role');
report(!list.needsCollapse('1\n2\n3\n4\n5'), '"Show more": 5 short lines stay open');
report(list.needsCollapse('1\n2\n3\n4\n5\n6'), '"Show more": 6 lines collapse');
report(list.needsCollapse(`https://example.com/${'x'.repeat(420)}`), '"Show more": one very long line (e.g. a URL) collapses');
report(!list.needsCollapse('') && !list.needsCollapse(null), '"Show more": no text, nothing to collapse');

// Decisions (reviewer Group 6)
report(list.replyDeadlineDay(new Date('2026-11-07T10:00:00Z')) === '2026-11-10', 'Reply deadline: the third day after today (Budapest)');
report(list.replyDeadlineDay(new Date('2026-11-07T23:30:00Z')) === '2026-11-11', 'Reply deadline: after midnight in Budapest it is already the next day', list.replyDeadlineDay(new Date('2026-11-07T23:30:00Z')));
report(list.replyDeadlineDay(new Date('2026-10-23T10:00:00Z')) === '2026-10-26', 'Reply deadline across the clock change (winter time starts 25 Oct)');
report(list.replyDeadlineDay(new Date('2026-12-30T12:00:00Z')) === '2027-01-02', 'Reply deadline across the new year');
report(same(list.decisionProblems({ type: 'approved', grade: null }), { grade: 'GRADE_REQUIRED' }), 'Approve without a grade is refused');
report(same(list.decisionProblems({ type: 'approved', grade: 6 }), { grade: 'GRADE_REQUIRED' }) && same(list.decisionProblems({ type: 'approved', grade: 1 }), { grade: 'GRADE_REQUIRED' }), 'Approve with 1 or 6 is refused');
report(same(list.decisionProblems({ type: 'approved', grade: 4, note: '' }), {}), 'Approve with grade 4 and no note is fine');
report(same(list.decisionProblems({ type: 'rejected', note: '   ' }), { note: 'RATIONALE_REQUIRED' }), 'Reject needs a rationale (spaces only do not count)');
report(same(list.decisionProblems({ type: 'needs_info', note: '' }), { note: 'MESSAGE_REQUIRED' }), 'Request info needs a message');
report(same(list.decisionProblems({ type: 'rejected', note: 'é'.repeat(2000) }), {}) && same(list.decisionProblems({ type: 'rejected', note: 'x'.repeat(2001) }), { note: 'NOTE_TOO_LONG' }),
    'Text limit: 2000 characters (accented letters count as one)');
const fakeT = (key) => ({ grade_name_4: 'good', grade_name_2: 'pass' })[key];
report(grades.gradeText(4, fakeT, 'hu') === '4 (jó)' && grades.gradeText(4, fakeT, 'en') === '4 (jó – good)' && grades.gradeText(null, fakeT, 'en') === '—',
    'Grade labels: the Hungarian name always, the local one next to it', grades.gradeText(4, fakeT, 'en'));

// Colour cues (reviewer group L2)
report(same([0, 6, 7, 13, 14, 40].map(list.waitingLevel), ['normal', 'normal', 'warn', 'warn', 'late', 'late']),
    'Waiting time: under 7 days normal, 7-13 amber, 14+ red', [0, 6, 7, 13, 14, 40].map(list.waitingLevel).join(' '));
// "Now" 10:00 Budapest on 10 Nov; deadlines at 23:59:59 Budapest
const now = new Date('2026-11-10T09:00:00Z');
const deadline = (day) => new Date(`${day}T22:59:59Z`);
report(same(['2026-11-13', '2026-11-12', '2026-11-11', '2026-11-10'].map((d) => list.respondByLevel(deadline(d), now)), ['warn', 'warn', 'late', 'late']),
    'Respond by: amber, red when the deadline is tomorrow or today');
report(list.daysUntil(new Date('2026-11-10T23:30:00Z'), now) === 1, 'Days left are Budapest calendar days (23:30 UTC is already the next day there)');
report(same(list.statusCue('rejected', 'system'), { cue: 'system', labelKey: 'reviewer_status_rejected_system' })
    && list.statusCue('rejected', 'reviewer').cue === 'rejected' && list.statusCue('needs_info').cue === 'needs-info'
    && list.statusCue('approved').cue === 'approved' && list.statusCue('pending').labelKey === 'status_pending',
    'Status chips: a system rejection has its own cue and says System');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
