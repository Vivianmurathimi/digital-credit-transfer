const pool = require('../db');
const sendEmail = require('./sendEmail');
const { buildReviewerEmail } = require('./emailTemplates');

/**
 * Emails the ACTIVE reviewer of an application's programme (reviewer Group 6): a new application
 * ('newApplication') or the student's reply to a request for information ('studentReplied').
 * Call it WITHOUT await, after the HTTP response: it never throws. A programme without an active
 * reviewer is skipped quietly (logged), never an error.
 */
const notifyReviewer = async (applicationId, type) => {
    try {
        const { rows } = await pool.query(
            `SELECT r.name AS reviewer_name, r.email AS reviewer_email, r.preferred_language,
                    s.name AS student_name, a.target_course_code, a.target_courses->0->>'course_name' AS course_name
             FROM applications a
             JOIN users s ON s.id = a.student_id
             LEFT JOIN users r ON r.role = 'reviewer' AND r.deactivated_at IS NULL AND r.programme_id = a.programme_id
             WHERE a.id = $1`,
            [applicationId]
        );
        const row = rows[0];
        if (!row) return;
        if (!row.reviewer_email) {
            console.log(`ℹ️  Reviewer email (${type}) for application ${applicationId} skipped: the programme has no active reviewer`);
            return;
        }
        const course = row.course_name ? `${row.target_course_code} – ${row.course_name}` : row.target_course_code;
        const email = buildReviewerEmail(type, row.preferred_language, { name: row.reviewer_name, student: row.student_name, course });
        if (email) await sendEmail({ email: row.reviewer_email, subject: email.subject, html: email.html });
    } catch (err) {
        console.error(`❌ Reviewer notification (${type}) for application ${applicationId} failed:`, err.message);
    }
};

module.exports = notifyReviewer;
