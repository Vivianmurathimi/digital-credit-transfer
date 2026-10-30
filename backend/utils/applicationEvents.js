const { getFileOwner } = require('./fileOwner');

// History of each application (migration 007). Events are only ever added: nothing here
// (or anywhere else) updates or deletes them, and the database refuses it too.

// fulfilled_courses_json is jsonb, but older rows may hold a JSON string
const parseList = (value) => {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

// Who did something, as the student is told: never a personal name
const actorRoleOf = (user) => (user.role === 'superadmin' ? 'admin' : user.role);

/**
 * Adds one step to an application's history. Pass the transaction's client, so the event is
 * saved together with the status change it describes (or not at all).
 * @param {{ query: Function }} db  pool or transaction client
 * @param {{ applicationId: number, kind: string, actorRole: string, actorId?: number|null, status: string,
 *           note?: string|null, reasonCode?: string|null, files?: string[] }} event
 */
const addEvent = (db, { applicationId, kind, actorRole, actorId = null, status, note = null, reasonCode = null, files = [] }) => db.query(
    `INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note, reason_code, files)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [applicationId, kind, actorRole, actorId, status, note, reasonCode, files]
);

// What a student may see of their applications. An explicit list (never SELECT *), so a new
// internal column (e.g. reviewed_by) can't reach the browser by accident.
// created_at is stored as UTC without a time zone, so it is read "AT TIME ZONE 'UTC'".
// decided_*: the latest step that set the status (request for information, decision,
// withdrawal or automatic rejection): who ("reviewer", "admin", "system", "student") and when.
const STUDENT_APPLICATION_QUERY = `
    SELECT a.id, a.status, a.target_courses, a.target_course_code, a.pte_course_names, a.fulfilled_courses_json,
           a.reviewer_note, a.info_deadline, a.created_at AT TIME ZONE 'UTC' AS submitted_at,
           r.resubmit_count, r.last_resubmitted_at,
           d.actor_role AS decided_by, d.created_at AS decided_at, d.reason_code AS decision_reason
    FROM applications a
    LEFT JOIN LATERAL (
        SELECT count(*)::int AS resubmit_count, max(e.created_at) AS last_resubmitted_at
        FROM application_events e WHERE e.application_id = a.id AND e.kind = 'replied'
    ) r ON true
    LEFT JOIN LATERAL (
        SELECT e.actor_role, e.created_at, e.reason_code
        FROM application_events e
        WHERE e.application_id = a.id AND e.kind IN ('info_requested', 'decided', 'withdrawn', 'auto_rejected')
        ORDER BY e.created_at DESC, e.id DESC LIMIT 1
    ) d ON true`;

const listStudentApplications = async (db, studentId) => (await db.query(
    `${STUDENT_APPLICATION_QUERY} WHERE a.student_id = $1 ORDER BY a.created_at DESC, a.id DESC`, [studentId]
)).rows;

/**
 * One application with everything the student may see, or null when it isn't this student's
 * (another student's application and an id that doesn't exist give the same answer).
 */
const getStudentApplication = async (db, studentId, applicationId) => {
    const id = Number(applicationId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;

    const found = await db.query(`${STUDENT_APPLICATION_QUERY} WHERE a.id = $1 AND a.student_id = $2`, [id, studentId]);
    if (found.rows.length === 0) return null;
    const application = found.rows[0];

    const extra = (await db.query(
        'SELECT institutions, syllabus_reasons FROM applications WHERE id = $1', [id]
    )).rows[0];
    // The conversation in order. actor_id stays on the server.
    const events = (await db.query(
        `SELECT kind, actor_role, status, note, reason_code, files, backfilled, created_at
         FROM application_events WHERE application_id = $1 ORDER BY created_at, id`, [id]
    )).rows;

    // The names the student gave their files, read from the files themselves
    const courses = parseList(application.fulfilled_courses_json);
    const institutions = Array.isArray(extra.institutions) ? extra.institutions : [];
    const files = new Set([
        ...courses.flatMap((c) => [c.file, c.syllabus_file]),
        ...institutions.map((i) => i.grading_file),
        ...events.flatMap((e) => e.files),
    ].filter((f) => typeof f === 'string' && f));
    const fileNames = {};
    for (const fileName of files) {
        const { exists, ownerId, originalName } = await getFileOwner(fileName);
        if (exists && ownerId === studentId && originalName) fileNames[fileName] = originalName;
    }

    return { ...application, institutions, syllabus_reasons: extra.syllabus_reasons, events, file_names: fileNames };
};

module.exports = { actorRoleOf, addEvent, listStudentApplications, getStudentApplication };
