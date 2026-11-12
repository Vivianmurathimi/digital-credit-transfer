import { cueForStatus } from './theme/statusCues.js'; // .js: also loaded by npm run check:reviewer-list (Node)
// The reviewer dashboard's list rules (reviewer Group 3), without React, so they can be tested on
// their own (npm run check:reviewer-list). The backend decides WHICH applications are listed (own
// programme only, completed ones of the current semester only); these only split, search and sort them.

export const TABS = ['pending', 'needs_info', 'completed'];

// The tab an application belongs to (null: not listed, e.g. withdrawn)
export const tabOf = (app) => {
    if (app.status === 'pending' || app.status === 'needs_info') return app.status;
    // Decided by the reviewer and waiting for the committee (round 2 Group 2) belongs with the decided ones
    if (app.status === 'approved' || app.status === 'rejected' || app.status === 'awaiting_committee') return 'completed';
    return null;
};

/**
 * Text for comparing, without case or accents: "Kovács Ödön" -> "kovacs odon", "Straße" -> "strasse".
 * NFD splits a letter from its accent marks (also Hungarian ő and ű), which are then dropped.
 */
export const foldText = (value) => String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss');

// fulfilled_courses_json is JSONB; very old rows may hold a JSON string
const parseList = (value) => {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

export const fulfilledCourses = (app) => parseList(app.fulfilled_courses_json);

// The one target PTE course (from the snapshot taken at submission)
export const targetCourse = (app) => {
    const [first] = parseList(app.target_courses);
    return { course_code: first?.course_code || app.target_course_code || '', course_name: first?.course_name || '', credits: first?.credits ?? null };
};

// The fulfilled course names of a list row (the list sends only the names; full rows also work)
const fulfilledNames = (app) => (Array.isArray(app.fulfilled_course_names)
    ? app.fulfilled_course_names
    : fulfilledCourses(app).map((c) => c.course_name));

// Everything the search looks in: student name, Neptun code, target course code and name, fulfilled course names
export const searchableText = (app) => {
    const target = targetCourse(app);
    return foldText([
        app.student_name, app.neptun_code, target.course_code, target.course_name, ...fulfilledNames(app),
    ].filter(Boolean).join(' \u0000 '));
};

// Every word of the query must appear (in any of the fields), ignoring case and accents
export const matchesSearch = (app, query) => {
    const words = foldText(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const text = searchableText(app);
    return words.every((word) => text.includes(word));
};

// Oldest first, by the student's last action (submission or reply); the id keeps equal times stable
export const sortByLastAction = (apps) => [...apps].sort((a, b) => (
    (new Date(a.last_action_at) - new Date(b.last_action_at)) || (a.id - b.id)
));

// Sharing work (round 2 Group 1): who an application is assigned to. 'all' everything the
// reviewer sees, 'mine' assigned to them, 'unassigned' shared (nobody assigned).
export const ASSIGNMENT_FILTERS = ['all', 'mine', 'unassigned'];
export const matchesAssignment = (app, assignment = 'all', me = null) => {
    const assigned = app.assigned_reviewer_id ?? null;
    if (assignment === 'mine') return assigned !== null && assigned === me;
    if (assignment === 'unassigned') return assigned === null;
    return true;
};
// Assigned to another reviewer: deciding it asks "This is assigned to X. Decide anyway?"
export const assignedToSomeoneElse = (app, me) => (app.assigned_reviewer_id ?? null) !== null && app.assigned_reviewer_id !== me;

/**
 * The rows of one tab: matching the search and, when set, only one student's applications of one
 * semester (the "other applications from this student" filter) and the assignment filter (me: the
 * reviewer's id). Sorted oldest first.
 * @param {{ studentId: number, semesterId: number|null } | null} student
 */
export const rowsFor = (apps, { tab, query = '', student = null, assignment = 'all', me = null }) => sortByLastAction(apps.filter((app) => (
    tabOf(app) === tab
    && matchesSearch(app, query)
    && (!student || (app.student_id === student.studentId && (app.semester_id ?? null) === (student.semesterId ?? null)))
    && matchesAssignment(app, assignment, me)
)));

// How many rows each tab has with the same search, student and assignment filter
export const countsFor = (apps, { query = '', student = null, assignment = 'all', me = null }) => Object.fromEntries(
    TABS.map((tab) => [tab, rowsFor(apps, { tab, query, student, assignment, me }).length])
);

// ---------- the details (reviewer Group 4) ----------

// Credits are whole or half numbers; adding them as tenths avoids 0.1 + 0.2 style results
const sumCredits = (values) => values.reduce((total, value) => total + Math.round(Number(value) * 10), 0) / 10;

/**
 * Fulfilled credits against the target course's credits.
 * - every fulfilled course in ECTS: { mode: 'ects', total, required, enough } (enough: null when the
 *   target course has no credits recorded)
 * - any other credit system (or no fulfilled course): { mode: 'manual' }, credits are compared by hand
 * @param {{ credits, credit_system }[]} courses
 */
export const creditComparison = (courses, requiredCredits) => {
    if (!courses.length || !courses.every((c) => c.credit_system === 'ECTS')) return { mode: 'manual' };
    const total = sumCredits(courses.map((c) => c.credits));
    const required = requiredCredits === null || requiredCredits === undefined || requiredCredits === '' ? null : Number(requiredCredits);
    return { mode: 'ects', total, required, enough: required === null ? null : total >= required };
};

// ---------- notes and history (reviewer Group 5) ----------

// Oldest first; events saved in the same moment keep the order they were added in (id)
export const sortEvents = (events) => [...events].sort((a, b) => (
    (new Date(a.created_at) - new Date(b.created_at)) || (a.id - b.id)
));

/**
 * The conversation: every event with a note, in time order, each with its box type
 * (student, resubmit, reviewer, system: the note_type from the application_notes view).
 * A reply that only added files has no note but still belongs here, with its files.
 */
export const conversationOf = (events) => sortEvents(events)
    .filter((e) => e.note_type || (e.kind === 'replied' && (e.files || []).length > 0))
    .map((e) => ({ ...e, boxType: e.note_type || 'resubmit' }));

/**
 * Who did it, for the label: the student's or reviewer's name; "Admin" and "System" never show
 * a personal name. labelKey: the translation key to use instead of a name.
 */
export const authorOf = (event) => {
    if (event.actor_role === 'admin') return { labelKey: 'reviewer_author_admin' };
    if (event.actor_role === 'system') return { labelKey: 'reviewer_author_system' };
    if (event.actor_name) return { name: event.actor_name };
    // The account was deleted (actor_id set to NULL): only the role is known
    return { labelKey: event.actor_role === 'student' ? 'reviewer_author_student' : 'reviewer_author_reviewer' };
};

/**
 * Whether a note is long enough to collapse behind "Show more": more than `maxLines` lines on
 * screen. A line longer than `charsPerLine` wraps, so it counts as several.
 */
export const NOTE_PREVIEW_LINES = 5;
export const needsCollapse = (text, { maxLines = NOTE_PREVIEW_LINES, charsPerLine = 80 } = {}) => {
    const lines = String(text ?? '').split(/\r?\n/);
    const screenLines = lines.reduce((total, line) => total + Math.max(1, Math.ceil([...line].length / charsPerLine)), 0);
    return screenLines > maxLines;
};

// ---------- decisions (reviewer Group 6) ----------

// The longest note, message or rationale (the backend's NOTE_MAX), counted in characters like the backend
export const DECISION_TEXT_MAX = 2000;
export const textLength = (text) => [...String(text ?? '').normalize('NFC')].length;

/**
 * The day a student must reply by when information is requested now: the third day after today,
 * in Budapest, until 23:59:59 (the database's info_reply_deadline). Returned as 'YYYY-MM-DD'.
 */
export const replyDeadlineDay = (now = new Date()) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const [y, m, d] = today.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 3)).toISOString().slice(0, 10);
};

/**
 * The decision panel's own checks before saving (the backend checks the same again).
 * @returns {{ grade?: string, note?: string }} error codes per field; empty when fine
 */
export const decisionProblems = ({ type, grade, note }) => {
    const problems = {};
    const length = textLength(String(note ?? '').trim());
    if (type === 'approved' && ![2, 3, 4, 5].includes(grade)) problems.grade = 'GRADE_REQUIRED';
    if (type === 'rejected' && length === 0) problems.note = 'RATIONALE_REQUIRED';
    if (type === 'needs_info' && length === 0) problems.note = 'MESSAGE_REQUIRED';
    if (length > DECISION_TEXT_MAX) problems.note = 'NOTE_TOO_LONG';
    return problems;
};

// ---------- colour cues (reviewer group L2) ----------
// Which cue (a --cue-* token family) a state gets. Every cue is shown with its text or icon too.

/** Waiting time: under 7 days normal, 7-13 days amber, 14 or more red */
export const waitingLevel = (days) => (days >= 14 ? 'late' : days >= 7 ? 'warn' : 'normal');

// A moment as its Budapest calendar day, counted in whole days (for differences between days)
const budapestDayNumber = (at) => {
    const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(at)).split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
};

/** Calendar days (Budapest) from today until the reply deadline's day: 0 = today, 1 = tomorrow, negative = passed */
export const daysUntil = (deadline, now = new Date()) => budapestDayNumber(deadline) - budapestDayNumber(now);

/** "Respond by": amber, red when 1 day or less is left (the deadline is today or tomorrow) */
export const respondByLevel = (deadline, now = new Date()) => (daysUntil(deadline, now) <= 1 ? 'late' : 'warn');

/**
 * The status chip: its cue and its label key. A rejection by the system has its own muted cue and
 * says "System"; everything else shows the status name.
 */
export const statusCue = (status, decidedByRole = null) => {
    if (status === 'rejected' && decidedByRole === 'system') return { cue: 'system', labelKey: 'reviewer_status_rejected_system' };
    // The same cue as on every other screen (theme/statusCues.js, admin round Group 8)
    return { cue: cueForStatus(status), labelKey: `status_${status}` };
};
