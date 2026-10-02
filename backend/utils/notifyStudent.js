const pool = require('../db');
const sendEmail = require('./sendEmail');
const { buildEmail } = require('./emailTemplates');
const { createEmailLink } = require('./emailLink');

/**
 * Emails a student about their application, in their preferred language.
 * Call it WITHOUT await, after the HTTP response has been sent:
 * it never throws, so a mail or database problem only gets logged
 * and can never make the user's action fail.
 *
 * @param {number} studentId
 * @param {'submitted'|'resubmitted'|'needsInfo'|'statusUpdate'} type
 * @param {{ status?: string, note?: string }} data
 */
const notifyStudent = async (studentId, type, data = {}) => {
    try {
        const result = await pool.query(
            'SELECT name, email, preferred_language FROM users WHERE id = $1',
            [studentId]
        );
        if (result.rows.length === 0) {
            console.error(`❌ Notification skipped: student ${studentId} not found`);
            return;
        }
        const student = result.rows[0];

        const linkUrl = createEmailLink(studentId);
        const email = buildEmail(type, student.preferred_language, { ...data, name: student.name, linkUrl });
        if (!email) return; // nothing to send for this event

        await sendEmail({ email: student.email, subject: email.subject, html: email.html });
    } catch (err) {
        console.error(`❌ Notification (${type}) for student ${studentId} failed:`, err.message);
    }
};

module.exports = notifyStudent;
