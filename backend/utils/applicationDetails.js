const { getFileOwner, splitFileList } = require('./fileOwner');
const { semesterEndedSql } = require('./semesters');

// One application with everything the reviewer's details show (reviewer Group 4): student, target
// course, completed courses, institutions, files, the conversation and history, the decision.
// Shared by the reviewer's details (their programme) and the admin's Past semesters (one closed
// semester, any programme; admin round Group 6), so both always show the same.

const asList = (value) => (Array.isArray(value) ? value : []);

/**
 * @param {{ query: Function }} db
 * @param {number} id  the application
 * @param {{ programmeIds?: number[]|null, semesterId?: number|null }} limits  null = no limit (programmeIds: a reviewer's visible programmes)
 * @returns {Promise<object|null>}  null when it isn't there (or withdrawn, or outside the limits)
 */
// includeWithdrawn: the admin's Past semesters shows withdrawn applications too (the reviewer never sees them)
const loadApplicationDetails = async (db, id, { programmeIds = null, semesterId = null, includeWithdrawn = false } = {}) => {
    const found = (await db.query(
        `SELECT a.id, a.status, a.student_id, a.target_course_code, a.target_courses, a.fulfilled_courses_json, a.institutions,
                a.supplemental_files, a.final_grade, a.decided_by_role, decider.name AS decided_by_name, a.decided_at,
                a.decision_rationale, a.info_deadline AS respond_by,
                a.reviewer_decision, a.reviewer_grade, a.committee_state, a.committee_at, a.committee_note, a.committee_by_role,
                ${semesterEndedSql('a')} AS read_only, sem.id AS semester_id, sem.name AS semester_name,
                u.name AS student_name, u.neptun_code, p.code AS programme_code, p.name_en, p.name_hu, p.name_de
         FROM applications a
         JOIN users u ON u.id = a.student_id
         JOIN programmes p ON p.id = a.programme_id
         LEFT JOIN semesters sem ON sem.id = a.semester_id
         LEFT JOIN users decider ON decider.id = a.decided_by
         WHERE a.id = $1 AND ($2::int[] IS NULL OR a.programme_id = ANY($2::int[])) AND ($3::int IS NULL OR a.semester_id = $3)
           AND ($4::boolean OR a.status <> 'withdrawn')`,
        [id, programmeIds, semesterId, includeWithdrawn]
    )).rows[0];
    if (!found) return null;

    const courses = asList(found.fulfilled_courses_json);
    const institutions = asList(found.institutions);
    // The history. actor_id stays on the server: only the name is sent (no email addresses), and
    // only for students and reviewers; an admin is shown as "Admin", the system as "System"
    const events = (await db.query(
        `SELECT e.id, e.kind, e.actor_role, CASE WHEN e.actor_role IN ('student', 'reviewer') THEN u.name END AS actor_name,
                e.status, e.note, e.reason_code,
                -- an automatic rejection has no text, only its reason code: still a "system" note
                COALESCE(n.note_type, CASE WHEN e.kind = 'auto_rejected' AND e.reason_code IS NOT NULL THEN 'system' END) AS note_type,
                e.files, e.backfilled, e.created_at
         FROM application_events e
         LEFT JOIN application_notes n ON n.id = e.id
         LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.application_id = $1
         ORDER BY e.created_at, e.id`,
        [id]
    )).rows;
    // Reply files sit with their reply. Files only in the old comma list (from before the history
    // kept them; migration 007 copied the latest ones over) are listed on their own.
    const eventFiles = events.flatMap((e) => e.files);
    const extraFiles = splitFileList(found.supplemental_files).filter((f) => !eventFiles.includes(f));

    const names = new Set([
        ...courses.flatMap((c) => [c.file, c.syllabus_file]),
        ...institutions.map((i) => i.grading_file),
        ...eventFiles,
        ...extraFiles,
    ].filter((f) => typeof f === 'string' && f));
    const files = {};
    for (const name of names) {
        const { exists, originalName } = await getFileOwner(name);
        files[name] = { exists, original_name: exists ? originalName || null : null };
    }

    const [target] = asList(found.target_courses);
    return {
            id: found.id,
            status: found.status,
            student: {
                id: found.student_id, name: found.student_name, neptun_code: found.neptun_code,
                programme: { code: found.programme_code, name_en: found.name_en, name_hu: found.name_hu, name_de: found.name_de },
            },
            target_course: {
                course_code: target?.course_code || found.target_course_code || '',
                course_name: target?.course_name || '',
                credits: target?.credits ?? null,
            },
            fulfilled_courses: courses,
            institutions,
            extra_files: extraFiles,
            files,
            events,
            // The decision (reviewer Group 6); the decider's name only for a reviewer. Round 2 Group 2:
            // reviewer_decision / reviewer_grade = what the reviewer or admin decided (kept for good);
            // final_grade and the application's status = the final result (the committee's); the
            // committee's step (state, when, note). Who in the committee acted: only the admin's views.
            decision: {
                final_grade: found.final_grade,
                reviewer_decision: found.reviewer_decision,
                reviewer_grade: found.reviewer_grade,
                committee_state: found.committee_state,
                committee_at: found.committee_at,
                committee_note: found.committee_note,
                committee_by_role: found.committee_by_role,
                decided_by_role: found.decided_by_role,
                decided_by_name: found.decided_by_role === 'reviewer' ? found.decided_by_name : null,
                decided_at: found.decided_at,
                rationale: found.decision_rationale,
                // An automatic rejection's reason (reviewer Group 7): a code, translated by the screen
                reason_code: found.decided_by_role === 'system'
                    ? [...events].reverse().find((e) => e.kind === 'auto_rejected')?.reason_code || null
                    : null,
            },
            respond_by: found.respond_by,
            // Its semester has ended (reviewer group L3): shown read-only, every change is refused
            semester: found.semester_id ? { id: found.semester_id, name: found.semester_name } : null,
            read_only: found.read_only,
    };
};

module.exports = { loadApplicationDetails };
