const pool = require('../db');
const sendEmail = require('./sendEmail');
const { buildReviewerEmail } = require('./emailTemplates');
const { seesProgrammeSql } = require('./reviewers');

/**
 * Emails everyone who can see an application's programme (its main reviewer, and extra reviewers
 * while allowed to assist; utils/reviewers.js): a new application ('newApplication') or the
 * student's reply to a request for information ('studentReplied').
 * Call it WITHOUT await, after the HTTP response: it never throws. A programme nobody can see now
 * is skipped quietly (logged), never an error.
 */
const notifyReviewer = async (applicationId, type) => {
    try {
        const { rows } = await pool.query(
            `SELECT r.name AS reviewer_name, r.email AS reviewer_email, r.preferred_language,
                    s.name AS student_name, a.target_course_code, a.target_courses->0->>'course_name' AS course_name
             FROM applications a
             JOIN users s ON s.id = a.student_id
             JOIN staff_programmes sp ON sp.programme_id = a.programme_id AND ${seesProgrammeSql('sp')}
             JOIN users r ON r.id = sp.user_id AND r.deactivated_at IS NULL
             WHERE a.id = $1
             ORDER BY r.id`,
            [applicationId]
        );
        if (rows.length === 0) {
            console.log(`ℹ️  Reviewer email (${type}) for application ${applicationId} skipped: nobody can review the programme now`);
            return;
        }
        for (const row of rows) {
            const course = row.course_name ? `${row.target_course_code} – ${row.course_name}` : row.target_course_code;
            const email = buildReviewerEmail(type, row.preferred_language, { name: row.reviewer_name, student: row.student_name, course });
            if (email) await sendEmail({ email: row.reviewer_email, subject: email.subject, html: email.html });
        }
    } catch (err) {
        console.error(`❌ Reviewer notification (${type}) for application ${applicationId} failed:`, err.message);
    }
};

module.exports = notifyReviewer;
