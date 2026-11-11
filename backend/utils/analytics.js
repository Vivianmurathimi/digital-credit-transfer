// How a semester went (admin round Group 7), calculated in the database, per semester:
//
// - Applications by status (pending, needs info, approved, rejected, withdrawn), overall and per programme.
// - Time to decision: submission -> final decision (approved or rejected), in days, per programme
//   and overall: count, average and median. Reviewer AND admin decisions count; System
//   auto-rejections (no reply in time, semester closed) are left out. It includes the time the
//   student spent answering a request for information, so it is shown a second time WITHOUT that
//   waiting: each "information requested" step until the student's next reply (or, if none came,
//   until the decision), from the application history (application_events).
// - The 10 most-requested PTE courses: every application except withdrawn ones (auto-rejected ones
//   count too: they still show which courses students asked for), by programme and course code.
//
// Days are elapsed time (hours / 24), rounded to one decimal when sent.

const STATUSES = ['pending', 'needs_info', 'approved', 'rejected', 'withdrawn'];
const TOP_COURSES = 10;

const round1 = (value) => (value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10);
const names = (row) => ({ code: row.programme_code, name_en: row.name_en, name_hu: row.name_hu, name_de: row.name_de });

/**
 * @param {{ query: Function }} db
 * @param {number} semesterId
 * @returns {Promise<{ status, turnaround, topCourses }>}
 */
const semesterAnalytics = async (db, semesterId) => {
    // ---- applications by status ----
    const byProgramme = (await db.query(
        `SELECT p.code AS programme_code, p.name_en, p.name_hu, p.name_de,
                ${STATUSES.map((s) => `count(*) FILTER (WHERE a.status = '${s}')::int AS ${s}`).join(', ')},
                count(*)::int AS total
         FROM applications a JOIN programmes p ON p.id = a.programme_id
         WHERE a.semester_id = $1
         GROUP BY p.id ORDER BY p.code`,
        [semesterId]
    )).rows;
    const overall = Object.fromEntries([...STATUSES, 'total'].map((s) => [s, byProgramme.reduce((sum, row) => sum + row[s], 0)]));

    // ---- time to decision ----
    // waiting: every "information requested" step until the next reply, withdrawal or decision
    const turnaround = (await db.query(
        `WITH decided AS (
             SELECT a.id, a.programme_id,
                    GREATEST(EXTRACT(EPOCH FROM (a.decided_at - (a.created_at AT TIME ZONE 'UTC'))) / 86400, 0) AS days,
                    COALESCE(w.waiting_days, 0) AS waiting_days
             FROM applications a
             LEFT JOIN LATERAL (
                 SELECT sum(GREATEST(EXTRACT(EPOCH FROM (LEAST(COALESCE(nxt.created_at, a.decided_at), a.decided_at) - e.created_at)) / 86400, 0)) AS waiting_days
                 FROM application_events e
                 LEFT JOIN LATERAL (
                     SELECT n.created_at FROM application_events n
                     WHERE n.application_id = e.application_id AND n.kind IN ('replied', 'decided', 'withdrawn', 'auto_rejected')
                       AND (n.created_at > e.created_at OR (n.created_at = e.created_at AND n.id > e.id))
                     ORDER BY n.created_at, n.id LIMIT 1
                 ) nxt ON true
                 WHERE e.application_id = a.id AND e.kind = 'info_requested' AND e.created_at <= a.decided_at
             ) w ON true
             WHERE a.semester_id = $1 AND a.status IN ('approved', 'rejected')
               AND a.decided_by_role IN ('reviewer', 'admin') AND a.decided_at IS NOT NULL
         )
         SELECT d.programme_id, p.code AS programme_code, p.name_en, p.name_hu, p.name_de,
                count(*)::int AS decided,
                avg(d.days) AS average_days,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY d.days) AS median_days,
                avg(GREATEST(d.days - d.waiting_days, 0)) AS average_without_waiting,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(d.days - d.waiting_days, 0)) AS median_without_waiting
         FROM decided d LEFT JOIN programmes p ON p.id = d.programme_id
         GROUP BY GROUPING SETS ((d.programme_id, p.code, p.name_en, p.name_hu, p.name_de), ())
         ORDER BY d.programme_id IS NULL, p.code`,
        [semesterId]
    )).rows.map((r) => ({
        programme: r.programme_id === null ? null : names(r), // null = all programmes together
        decided: r.decided,
        averageDays: round1(r.average_days), medianDays: round1(r.median_days),
        averageDaysWithoutWaiting: round1(r.average_without_waiting), medianDaysWithoutWaiting: round1(r.median_without_waiting),
    }));
    const overallTurnaround = turnaround.find((t) => t.programme === null)
        || { programme: null, decided: 0, averageDays: null, medianDays: null, averageDaysWithoutWaiting: null, medianDaysWithoutWaiting: null };

    // ---- top requested courses ----
    const topCourses = (await db.query(
        `SELECT p.code AS programme_code, p.name_en, p.name_hu, p.name_de, a.target_course_code AS course_code,
                (array_agg(a.target_courses->0->>'course_name' ORDER BY a.id DESC))[1] AS course_name,
                count(*)::int AS applications
         FROM applications a JOIN programmes p ON p.id = a.programme_id
         WHERE a.semester_id = $1 AND a.status <> 'withdrawn'
         GROUP BY p.id, a.target_course_code
         ORDER BY applications DESC, p.code, a.target_course_code
         LIMIT ${TOP_COURSES}`,
        [semesterId]
    )).rows.map((r) => ({ programme: names(r), courseCode: r.course_code, courseName: r.course_name, applications: r.applications }));

    return {
        status: { overall, byProgramme: byProgramme.map((r) => ({ programme: names(r), ...Object.fromEntries([...STATUSES, 'total'].map((s) => [s, r[s]])) })) },
        turnaround: { overall: overallTurnaround, byProgramme: turnaround.filter((t) => t.programme !== null) },
        topCourses,
    };
};

module.exports = { semesterAnalytics, STATUSES, TOP_COURSES };
