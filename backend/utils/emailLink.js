const jwt = require('jsonwebtoken');

// Links in notification emails are only valid for a short time
const EMAIL_LINK_LIFETIME = '10m';

// Separate secret from login tokens, so an email link can never be used to log in
const linkSecret = () => `${process.env.JWT_SECRET || 'secret_key'}_email_link`;

// Signed link to the dashboard for one student, valid for 10 minutes
const createEmailLink = (studentId) => {
    const token = jwt.sign({ purpose: 'email_link', studentId }, linkSecret(), { expiresIn: EMAIL_LINK_LIFETIME });
    return `${process.env.FRONTEND_URL || 'http://localhost:3000'}/email-link/${token}`;
};

// Returns { valid: true, studentId } or { valid: false, reason: 'expired' | 'invalid' }
const checkEmailLink = (token) => {
    try {
        const decoded = jwt.verify(token, linkSecret());
        if (decoded.purpose !== 'email_link') return { valid: false, reason: 'invalid' };
        return { valid: true, studentId: decoded.studentId };
    } catch (err) {
        return { valid: false, reason: err.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
    }
};

module.exports = { createEmailLink, checkEmailLink };
