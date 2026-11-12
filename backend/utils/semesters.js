
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
 * submitted during its application period (created_at is stored as UTC without a time zone).
 * Safe to run again.
 * @returns {Promise<{ adoptedCourses: number, adoptedApplications: number }>}
 */
const adoptIntoSemester = async (db, semesterId) => {
    const courses = await db.query('UPDATE courses SET semester_id = $1 WHERE semester_id IS NULL', [semesterId]);
    const applications = await db.query(
        `UPDATE applications a SET semester_id = b.id FROM semester_bounds b
         WHERE b.id = $1 AND a.semester_id IS NULL
           AND a.created_at AT TIME ZONE 'UTC' >= b.opens_at AND a.created_at AT TIME ZONE 'UTC' < b.closes_at`,
        [semesterId]
    );
    return { adoptedCourses: courses.rowCount, adoptedApplications: applications.rowCount };
};

/**
 * Creates a semester (npm run semester:create, the dev seed, the demo and the tests; the admin
 * screen has its own route). Days are Budapest days: applications from 00:00 on applyFrom until
 * 23:59 on applyUntil; the review deadline is 23:59 on reviewUntil (default: REVIEW_DAYS_DEFAULT
 * days after applyUntil); `ends` is the semester's last day, a label only. status: setup (default),
 * active (several may be in progress) or closed (closedAt = the moment after `ends`). Courses
 * without a semester join it, and so do applications without one submitted during its period.
 * Refuses invalid or out-of-order days, a name that exists and an application period overlapping
 * another one, each with a message saying what is wrong.
 * @returns {Promise<{ id: number, adoptedCourses: number, adoptedApplications: number }>}
 */
const createSemester = async (db, { name, applyFrom, applyUntil, ends, reviewUntil = null, status = 'setup' }) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) throw new Error('The name is missing or longer than 50 characters.');
    for (const [label, value] of [['--apply-from', applyFrom], ['--apply-until', applyUntil], ['--ends', ends]]) {
        if (!isDay(value)) throw new Error(`${label} must be a real day written as YYYY-MM-DD (got "${value ?? ''}").`);
    }
    if (reviewUntil !== null && !isDay(reviewUntil)) throw new Error(`--review-until must be a real day written as YYYY-MM-DD (got "${reviewUntil}").`);
    if (!(applyFrom <= applyUntil)) throw new Error('The days are out of order: --apply-from <= --apply-until.');
    if (reviewUntil !== null && reviewUntil < applyUntil) throw new Error('The review deadline can\'t be before applications close: --apply-until <= --review-until.');
    if (!['setup', 'active', 'closed'].includes(status)) throw new Error('status must be setup, active or closed.');
    try {
        const { rows } = await db.query(
            `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date, closed_at)
             VALUES ($1, $5::varchar, $2::date::timestamp AT TIME ZONE 'Europe/Budapest',
                     ($3::date::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
                     (COALESCE($6::date, $3::date + $7::int)::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
                     $4::date,
                     CASE WHEN $5::varchar = 'closed' THEN ($4::date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' END)
             RETURNING id`,
            [name.trim(), applyFrom, applyUntil, ends, status, reviewUntil, REVIEW_DAYS_DEFAULT]
        );
        return { id: rows[0].id, ...(await adoptIntoSemester(db, rows[0].id)) };
    } catch (err) {
        if (err.code === '23505') throw new Error(`A semester called "${name.trim()}" already exists.`);
        if (err.code === '23P01') {
            const other = await db.query(
                `SELECT name, to_char(opens_at AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD') AS f, to_char(closes_at AT TIME ZONE 'Europe/Budapest', 'YYYY-MM-DD') AS t
                 FROM semester_bounds
                 WHERE tstzrange(opens_at, closes_at, '[)') && tstzrange($1::date::timestamp AT TIME ZONE 'Europe/Budapest', ($2::date::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest', '[)')
                 LIMIT 1`,
                [applyFrom, applyUntil]
            );
            const o = other.rows[0];
            throw new Error(`Its application period overlaps ${o ? `"${o.name}" (applications ${o.f} to ${o.t})` : 'another semester'}: application periods can't overlap.`);
        }
        throw err;
    }
};

/**
 * SQL: the application's semester is closed (reviewer group L3; admin round Group 6). A closed
 * semester is read-only: no status change of any kind, for anyone (also the admin and acting-as).
 * Until the admin's close it can be worked on (decisions, needs-info replies, withdrawals), also
 * after its review deadline. `table` is the applications table's name or alias.
 */
const semesterEndedSql = (table = 'applications') =>
    `EXISTS (SELECT 1 FROM semester_bounds ended WHERE ended.id = ${table}.semester_id AND ended.status = 'closed')`;

// The timeline's numbers (round 2 Group 1), the one place to change them:
// - REVIEW_DAYS_DEFAULT: a new semester's review deadline, this many days after applications close
//   (the admin moves it on the Semesters screen)
// - REVIEW_WARNING_DAYS: how long before the review deadline undecided applications are pointed out:
//   the reviewers' first reminder email and the admin's "review deadline soon" warning
// - REVIEW_MARGIN_DAYS: Reopen until or a late access deadline that leaves fewer days than this
//   before the review deadline: the admin is warned and offered to move the review deadline
const REVIEW_DAYS_DEFAULT = 14;
const REVIEW_WARNING_DAYS = 7;
const REVIEW_MARGIN_DAYS = 7;

// SQL: "the review deadline is within REVIEW_WARNING_DAYS from $n" for semester_bounds alias sb,
// on the Budapest wall clock (so a clock change never moves it by an hour)
const reviewSoonSql = (sb, nowParam) =>
    `((${sb}.review_ends_at AT TIME ZONE 'Europe/Budapest') - make_interval(days => ${REVIEW_WARNING_DAYS})) AT TIME ZONE 'Europe/Budapest' <= ${nowParam}`;

module.exports = {
    REVIEW_DAYS_DEFAULT, REVIEW_WARNING_DAYS, REVIEW_MARGIN_DAYS, reviewSoonSql,
    semesterEndedSql, createSemester, adoptIntoSemester,
};
