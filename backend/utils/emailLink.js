const jwt = require('jsonwebtoken');
const { JWT_SECRET, ALGORITHM } = require('../config/jwt');
const { FRONTEND_URL } = require('../config/urls');

// Links in notification emails are only valid for a short time
const EMAIL_LINK_LIFETIME = '10m';

// Separate secret from login tokens, so an email link can never be used to log in
const linkSecret = () => `${JWT_SECRET}_email_link`;

// Signed link to the dashboard for one student, valid for 10 minutes
const createEmailLink = (studentId) => {
    const token = jwt.sign({ purpose: 'email_link', studentId }, linkSecret(), { algorithm: ALGORITHM, expiresIn: EMAIL_LINK_LIFETIME });
    return `${FRONTEND_URL}/email-link/${token}`;
};

// Returns { valid: true, studentId } or { valid: false, reason: 'expired' | 'invalid' }
const checkEmailLink = (token) => {
    try {
        const decoded = jwt.verify(token, linkSecret(), { algorithms: [ALGORITHM] });
        if (decoded.purpose !== 'email_link') return { valid: false, reason: 'invalid' };
        return { valid: true, studentId: decoded.studentId };
    } catch (err) {
        return { valid: false, reason: err.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
    }
};

module.exports = { createEmailLink, checkEmailLink };
