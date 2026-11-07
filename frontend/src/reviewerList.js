// The reviewer dashboard's list rules (reviewer Group 3), without React, so they can be tested on
// their own (npm run check:reviewer-list). The backend decides WHICH applications are listed (own
// programme only, completed ones of the current semester only); these only split, search and sort them.

export const TABS = ['pending', 'needs_info', 'completed'];

// The tab an application belongs to (null: not listed, e.g. withdrawn)
export const tabOf = (app) => {
    if (app.status === 'pending' || app.status === 'needs_info') return app.status;
    if (app.status === 'approved' || app.status === 'rejected') return 'completed';
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

/**
 * The rows of one tab: matching the search and, when set, only one student's applications of one
 * semester (the "other applications from this student" filter). Sorted oldest first.
 * @param {{ studentId: number, semesterId: number|null } | null} student
 */
export const rowsFor = (apps, { tab, query = '', student = null }) => sortByLastAction(apps.filter((app) => (
    tabOf(app) === tab
    && matchesSearch(app, query)
    && (!student || (app.student_id === student.studentId && (app.semester_id ?? null) === (student.semesterId ?? null)))
)));

// How many rows each tab has with the same search and student filter
export const countsFor = (apps, { query = '', student = null }) => Object.fromEntries(
    TABS.map((tab) => [tab, rowsFor(apps, { tab, query, student }).length])
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
