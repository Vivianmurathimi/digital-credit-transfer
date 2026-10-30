const pool = require('../db');
const { ALL_STATUSES } = require('./applicationForm');

// Semester dates are calendar days in Hungary
const APP_TIMEZONE = 'Europe/Budapest';

// fulfilled_courses_json is jsonb, but older rows may hold a JSON string
const parseCourses = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const splitList = (text, separator) =>
    (text || '').split(separator).map((item) => item.trim()).filter(Boolean);

/**
 * Every application submitted between two dates (inclusive), with everything the term book needs.
 *
 * created_at / reviewed_at are stored as UTC without a time zone, so they are read
 * "AT TIME ZONE 'UTC'" here; otherwise Node would treat them as local time and shift them.
 *
 * @param {string} from  'YYYY-MM-DD', first day of the semester
 * @param {string} to    'YYYY-MM-DD', last day of the semester (included)
 */
const getTermData = async (from, to) => {
    const result = await pool.query(
        `SELECT a.id, a.status, a.fulfilled_courses_json, a.pte_course_names,
                a.student_note, a.system_note, a.reviewer_note, a.student_resubmit_note,
                a.supplemental_files,
                a.created_at AT TIME ZONE 'UTC' AS submitted_at,
                a.reviewed_at AT TIME ZONE 'UTC' AS reviewed_at,
                s.name AS student_name, s.email AS student_email,
                r.name AS reviewer_name, r.email AS reviewer_email
         FROM applications a
         JOIN users s ON s.id = a.student_id
         LEFT JOIN users r ON r.id = a.reviewed_by
         WHERE a.created_at AT TIME ZONE 'UTC' >= $1::date AT TIME ZONE '${APP_TIMEZONE}'
           AND a.created_at AT TIME ZONE 'UTC' <  ($2::date + 1) AT TIME ZONE '${APP_TIMEZONE}'
         ORDER BY a.created_at, a.id`,
        [from, to]
    );

    const applications = result.rows.map((row) => {
        // Evidence = each fulfilled course's file. Grading-system files (applications.institutions)
        // are not added to the term book yet: planned for the admin round (see docs/PLANNED.md).
        const courses = parseCourses(row.fulfilled_courses_json);

        // Evidence in page order: each course's file, then files added with missing info
        const evidence = [
            ...courses.filter((c) => c.file).map((c) => ({ file: c.file, label: c.course_name || c.course_code || '' })),
            // Syllabi (Group 5): images are embedded, highlighted PDFs are listed by name
            ...courses.filter((c) => c.syllabus_file).map((c) => ({ file: c.syllabus_file, label: `Syllabus: ${c.course_name || c.course_code || ''}` })),
            ...splitList(row.supplemental_files, ',').map((file, i) => ({ file, label: `Additional file ${i + 1}`, additional: true })),
        ];

        return {
            id: row.id,
            status: row.status,
            submittedAt: row.submitted_at,
            reviewedAt: row.reviewed_at,
            student: { name: row.student_name, email: row.student_email },
            reviewer: row.reviewer_name ? { name: row.reviewer_name, email: row.reviewer_email } : null,
            courses,
            pteCourses: splitList(row.pte_course_names, ' + '),
            notes: {
                student: row.student_note,
                system: row.system_note,
                reviewer: row.reviewer_note,
                resubmit: row.student_resubmit_note,
            },
            evidence,
        };
    });

    // Totals by status for the cover page (every known status listed, even at 0)
    const totals = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
    applications.forEach((app) => { totals[app.status] = (totals[app.status] || 0) + 1; });

    return { from, to, generatedAt: new Date(), total: applications.length, totals, applications };
};

module.exports = getTermData;
