// Unit tests for the reviewer side's pure helpers (reviewer Group 8):   npm test
// They replace Create React App's default App.test.js, which looked for a "learn react" link that
// no longer exists. App itself is not rendered here: it imports the ky HTTP client, which is
// published as an ES module only and would need extra Jest configuration.
// The fuller list checks run in: npm run check:reviewer-list
import { FINAL_GRADES, gradeText } from './grades';
import { authorOf, conversationOf, decisionProblems, DECISION_TEXT_MAX, needsCollapse, replyDeadlineDay, textLength } from './reviewerList';

const t = (key) => ({ grade_name_4: 'good', grade_name_5: 'excellent' }[key] || key);

test('final grades 2-5, always with the Hungarian name', () => {
    expect(FINAL_GRADES).toEqual([5, 4, 3, 2]);
    expect(gradeText(4, t, 'hu')).toBe('4 (jó)');
    expect(gradeText(4, t, 'en')).toBe('4 (jó – good)');
    expect(gradeText(null, t, 'en')).toBe('—');
});

test('the decision panel needs a grade to approve and a text to reject or request information', () => {
    expect(decisionProblems({ type: 'approved', grade: null, note: '' })).toEqual({ grade: 'GRADE_REQUIRED' });
    expect(decisionProblems({ type: 'approved', grade: 4, note: '' })).toEqual({});
    expect(decisionProblems({ type: 'rejected', note: '   ' })).toEqual({ note: 'RATIONALE_REQUIRED' });
    expect(decisionProblems({ type: 'needs_info', note: 'Send the syllabus.' })).toEqual({});
    expect(decisionProblems({ type: 'rejected', note: 'x'.repeat(DECISION_TEXT_MAX + 1) })).toEqual({ note: 'NOTE_TOO_LONG' });
    expect(textLength('😀'.repeat(3))).toBe(3); // characters, not UTF-16 units
});

test('the reply deadline is the third day after today in Budapest', () => {
    // 23:30 UTC on 24 October is already 25 October in Budapest (summer time, UTC+2)
    expect(replyDeadlineDay(new Date('2026-10-24T23:30:00Z'))).toBe('2026-10-28');
    expect(replyDeadlineDay(new Date('2026-12-30T10:00:00Z'))).toBe('2027-01-02');
});

test('the conversation: notes in time order, an automatic rejection as a system note', () => {
    const events = [
        { id: 3, kind: 'auto_rejected', actor_role: 'system', note: null, note_type: 'system', reason_code: 'NO_INFO_RESPONSE', created_at: '2026-11-05T10:00:00Z' },
        { id: 1, kind: 'submitted', actor_role: 'student', actor_name: 'Anna', note: 'Hello', note_type: 'student', created_at: '2026-11-01T10:00:00Z' },
        { id: 2, kind: 'info_requested', actor_role: 'admin', note: 'More please', note_type: 'reviewer', created_at: '2026-11-02T10:00:00Z' },
    ];
    expect(conversationOf(events).map((e) => [e.id, e.boxType])).toEqual([[1, 'student'], [2, 'reviewer'], [3, 'system']]);
    expect(authorOf(events[2])).toEqual({ labelKey: 'reviewer_author_admin' });
    expect(authorOf(events[0])).toEqual({ labelKey: 'reviewer_author_system' });
    expect(authorOf(events[1])).toEqual({ name: 'Anna' });
});

test('long notes collapse after five screen lines', () => {
    expect(needsCollapse('one\ntwo\nthree')).toBe(false);
    expect(needsCollapse('a\nb\nc\nd\ne\nf')).toBe(true);
    expect(needsCollapse('x'.repeat(81 * 5))).toBe(true);
});
