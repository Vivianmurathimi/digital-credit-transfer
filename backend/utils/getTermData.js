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
const getTermData = async (from, to) => loadTermData({
    where: `a.created_at AT TIME ZONE 'UTC' >= $1::date AT TIME ZONE '${APP_TIMEZONE}'
           AND a.created_at AT TIME ZONE 'UTC' <  ($2::date + 1) AT TIME ZONE '${APP_TIMEZONE}'`,
    params: [from, to], from, to, showCommitteeMember: true, // the admin's archive
});

const SEMESTER_LABEL_SQL = `SELECT name, status, to_char(applications_open_at AT TIME ZONE '${APP_TIMEZONE}', 'YYYY-MM-DD') AS from_day,
    to_char(end_date, 'YYYY-MM-DD') AS to_day FROM semesters WHERE id = $1`;

/**
 * The term book of one semester (admin round Group 6): every application of that semester,
 * whatever its submission date. from / to: its opening day and last day (Budapest).
 * Round 2 Group 1, a reviewer's book: programmeIds limits it to those programmes (the reviewer's
 * visible ones) and withdrawn applications are left out, as on the reviewer's screen; a semester
 * still in progress is marked interim (not final). The admin's book: no options, as before.
 * @param {{ programmeIds?: number[]|null, programmes?: string[] }} options  programmes: their codes, for the cover
 */
const getSemesterTermData = async (semesterId, { programmeIds = null, programmes = [] } = {}) => {
    const semester = (await pool.query(SEMESTER_LABEL_SQL, [semesterId])).rows[0];
    if (!semester) throw new Error(`Semester ${semesterId} not found`);
    const forReviewer = programmeIds !== null;
    const data = await loadTermData({
        where: forReviewer ? "a.semester_id = $1 AND a.programme_id = ANY($2::int[]) AND a.status <> 'withdrawn'" : 'a.semester_id = $1',
        params: forReviewer ? [semesterId, programmeIds] : [semesterId],
        from: semester.from_day, to: semester.to_day, label: semester.name,
        showCommitteeMember: !forReviewer, // the admin's book says who in the committee acted; a reviewer's or member's doesn't
    });
    return { ...data, programmes: forReviewer ? programmes : null, interim: forReviewer && semester.status !== 'closed' };
};

/**
 * One application, for its own PDF (round 2 Group 1): the same pages as in the book, without the
 * cover and the index. null when it doesn't exist. interim: its semester isn't closed yet.
 * showCommitteeMember: who in the committee acted (round 2 Group 2): the admin's PDF only.
 */
const getApplicationTermData = async (applicationId, { showCommitteeMember = false } = {}) => {
    const found = (await pool.query('SELECT semester_id FROM applications WHERE id = $1', [applicationId])).rows[0];
    if (!found) return null;
    const semester = found.semester_id ? (await pool.query(SEMESTER_LABEL_SQL, [found.semester_id])).rows[0] : null;
    const data = await loadTermData({
        where: 'a.id = $1', params: [applicationId],
        from: semester ? semester.from_day : '', to: semester ? semester.to_day : '', label: semester ? semester.name : null, showCommitteeMember,
    });
    return { ...data, single: true, interim: !semester || semester.status !== 'closed' };
};

const loadTermData = async ({ where, params, from, to, label = null, showCommitteeMember = false }) => {
    const result = await pool.query(
        `SELECT a.id, a.status, a.fulfilled_courses_json, a.pte_course_names,
                a.student_note, a.system_note, a.reviewer_note, a.student_resubmit_note,
                a.supplemental_files,
                (SELECT e.reason_code FROM application_events e
                 WHERE e.application_id = a.id AND e.kind = 'auto_rejected' ORDER BY e.id DESC LIMIT 1) AS auto_reason,
                a.created_at AT TIME ZONE 'UTC' AS submitted_at,
                a.reviewed_at AT TIME ZONE 'UTC' AS reviewed_at,
                a.final_grade, a.decided_by_role, a.decided_at, a.decision_rationale, d.name AS decider_name,
                a.reviewer_decision, a.reviewer_grade, a.committee_state, a.committee_at, a.committee_note, a.committee_by_role,
                cm.name AS committee_member_name,
                s.name AS student_name, s.email AS student_email,
                r.name AS reviewer_name, r.email AS reviewer_email
         FROM applications a
         JOIN users s ON s.id = a.student_id
         LEFT JOIN users r ON r.id = a.reviewed_by
         LEFT JOIN users d ON d.id = a.decided_by
         LEFT JOIN users cm ON cm.id = a.committee_by
         WHERE ${where}
         ORDER BY a.created_at, a.id`,
        params
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
            // Rejected by the system at the semester end (Group 3): shown as not reviewed in the book
            notReviewedBySemesterEnd: row.status === 'rejected' && row.auto_reason === 'SEMESTER_ENDED',
            submittedAt: row.submitted_at,
            reviewedAt: row.reviewed_at,
            student: { name: row.student_name, email: row.student_email },
            reviewer: row.reviewer_name ? { name: row.reviewer_name, email: row.reviewer_email } : null,
            // The decision (reviewer Group 6): approved / rejected (round 2 Group 2: and awaiting the
            // committee). decidedBy: the reviewer's name, or 'Admin' / 'System' (from decided_by_role);
            // null for older decisions without it. finalGrade: the final one (none while awaiting).
            decision: ['approved', 'rejected', 'awaiting_committee'].includes(row.status) ? {
                finalGrade: row.final_grade,
                decidedBy: row.decided_by_role === 'admin' ? 'Admin'
                    : row.decided_by_role === 'system' ? 'System'
                        : row.decided_by_role === 'reviewer' ? (row.decider_name || 'Reviewer') : null,
                decidedAt: row.decided_at,
                rationale: row.decision_rationale,
                // An automatic rejection's reason code (reviewer Group 7); the PDF writes it in English
                reasonCode: row.decided_by_role === 'system' ? row.auto_reason : null,
                // The committee (round 2 Group 2): the reviewer's own decision and grade, then what the
                // committee did; who acted only in the admin's PDFs ('Admin, as committee' or the name)
                reviewerDecision: row.reviewer_decision,
                reviewerGrade: row.reviewer_grade,
                committee: ['awaiting', 'kept', 'changed'].includes(row.committee_state) ? {
                    state: row.committee_state,
                    at: row.committee_at,
                    note: row.committee_note,
                    by: !showCommitteeMember || !row.committee_by_role ? null
                        : row.committee_by_role === 'admin' ? 'Admin, as committee' : (row.committee_member_name || 'Committee member'),
                } : null,
            } : null,
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

    return { from, to, label, generatedAt: new Date(), total: applications.length, totals, applications };
};

module.exports = getTermData;
module.exports.getSemesterTermData = getSemesterTermData;
module.exports.getApplicationTermData = getApplicationTermData;
