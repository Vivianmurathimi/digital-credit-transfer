
// Semester helpers. Whether someone may register or submit is decided ONLY by
// utils/applicationPeriod.js (admin round Group 5).

// A real calendar day written as YYYY-MM-DD (2026-02-30 is refused)
const isDay = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/**
 * Courses without a semester join this one, and so do applications without one that were
 * submitted during it (created_at is stored as UTC without a time zone). Safe to run again.
 * @returns {Promise<{ adoptedCourses: number, adoptedApplications: number }>}
 */
const adoptIntoSemester = async (db, semesterId) => {
    const courses = await db.query('UPDATE courses SET semester_id = $1 WHERE semester_id IS NULL', [semesterId]);
    const applications = await db.query(
        `UPDATE applications a SET semester_id = b.id FROM semester_bounds b
         WHERE b.id = $1 AND a.semester_id IS NULL
           AND a.created_at AT TIME ZONE 'UTC' >= b.opens_at AND a.created_at AT TIME ZONE 'UTC' < b.ends_at`,
        [semesterId]
    );
    return { adoptedCourses: courses.rowCount, adoptedApplications: applications.rowCount };
};

/**
 * Creates a semester (npm run semester:create, the dev seed, the demo and the tests; the admin
 * screen has its own route). Days are Budapest days: applications from 00:00 on applyFrom until
 * 23:59 on applyUntil; the semester ends after `ends`. status: setup (default), active (only when
 * no other one is active) or closed (closedAt = its end). Courses without a semester join it, and
 * so do applications without one submitted during it. Refuses invalid or out-of-order days, a
 * name that exists and an overlap, each with a message saying what is wrong.
 * @returns {Promise<{ id: number, adoptedCourses: number, adoptedApplications: number }>}
 */
const createSemester = async (db, { name, applyFrom, applyUntil, ends, status = 'setup' }) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) throw new Error('The name is missing or longer than 50 characters.');
    for (const [label, value] of [['--apply-from', applyFrom], ['--apply-until', applyUntil], ['--ends', ends]]) {
        if (!isDay(value)) throw new Error(`${label} must be a real day written as YYYY-MM-DD (got "${value ?? ''}").`);
    }
    if (!(applyFrom <= applyUntil && applyUntil <= ends)) {
        throw new Error('The days are out of order: --apply-from <= --apply-until <= --ends.');
    }
    if (!['setup', 'active', 'closed'].includes(status)) throw new Error('status must be setup, active or closed.');
    try {
        const { rows } = await db.query(
            `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, end_date, closed_at)
             VALUES ($1, $5::varchar, $2::date::timestamp AT TIME ZONE 'Europe/Budapest',
                     ($3::date::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', $4::date,
                     CASE WHEN $5::varchar = 'closed' THEN ($4::date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' END)
             RETURNING id`,
            [name.trim(), applyFrom, applyUntil, ends, status]
        );
        return { id: rows[0].id, ...(await adoptIntoSemester(db, rows[0].id)) };
    } catch (err) {
        if (err.code === '23505' && err.constraint === 'semesters_one_active') throw new Error('Another semester is already active.');
        if (err.code === '23505') throw new Error(`A semester called "${name.trim()}" already exists.`);
        if (err.code === '23P01') {
            const other = await db.query(
                `SELECT name, to_char(opens_at AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD') AS f, ends_on::text AS t FROM semester_bounds
                 WHERE daterange((opens_at AT TIME ZONE 'Europe/Budapest')::date, ends_on, '[]') && daterange($1::date, $2::date, '[]') LIMIT 1`,
                [applyFrom, ends]
            );
            const o = other.rows[0];
            throw new Error(`It overlaps ${o ? `"${o.name}" (${o.f} to ${o.t})` : 'another semester'}: semesters can't overlap.`);
        }
        throw err;
    }
};

/**
 * SQL: the application's semester has ended (reviewer group L3). Past semesters are read-only:
 * no status change of any kind, for anyone. `table` is the applications table's name or alias.
 * Applications without a semester never count as ended.
 */
const semesterEndedSql = (table = 'applications') =>
    `EXISTS (SELECT 1 FROM semester_bounds ended WHERE ended.id = ${table}.semester_id AND (ended.ends_at <= now() OR ended.status = 'closed'))`;

// SQL for "the current semester" (admin round Group 4): the active one, set by the admin
const CURRENT_SEMESTER_SQL = "SELECT id, name FROM semester_bounds WHERE status = 'active' LIMIT 1";

module.exports = { CURRENT_SEMESTER_SQL, semesterEndedSql, createSemester, adoptIntoSemester };
