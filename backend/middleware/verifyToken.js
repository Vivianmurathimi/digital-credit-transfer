const pool = require('../db');
const { verifySessionToken, isSessionTooOld } = require('../config/jwt');
const sendError = require('../utils/sendError');

async function verifyToken(req, res, next) {
    // 1. Look for "Authorization: Bearer <token>" (any capitalisation, extra spaces ignored)
    const match = /^\s*bearer\s+(\S+)\s*$/i.exec(req.headers['authorization'] || '');
    if (!match) {
        return sendError(res, 401, 'NO_TOKEN', 'No token provided');
    }

    // 2. Verify it's real, signed with our algorithm, and not expired/tampered
    let decoded;
    try {
        decoded = verifySessionToken(match[1]);
    } catch (err) {
        // Expired (30 minutes without renewal) is told apart from forged/broken tokens
        if (err.name === 'TokenExpiredError') {
            return sendError(res, 401, 'TOKEN_EXPIRED', 'Your session has expired');
        }
        return sendError(res, 401, 'INVALID_TOKEN', 'Invalid token');
    }

    // 3. Even an active session ends 8 hours after login
    if (isSessionTooOld(decoded)) {
        return sendError(res, 401, 'SESSION_TOO_OLD', 'Session expired, please log in again');
    }

    // 4. Re-check the user in the database, so a deleted user is refused and a
    //    role change by the admin takes effect immediately (not when the token expires)
    try {
        const result = await pool.query('SELECT id, role, programme_id, reviewer_deactivated_at FROM users WHERE id = $1', [decoded.id]);
        if (result.rows.length === 0) {
            return sendError(res, 401, 'ACCOUNT_GONE', 'Account no longer exists');
        }
        const user = result.rows[0];
        // A removed reviewer (reviewer Group 2) is refused on every request, from the next one on
        if (user.role === 'reviewer' && user.reviewer_deactivated_at) {
            return sendError(res, 401, 'REVIEWER_REMOVED', 'Your reviewer access has been removed');
        }

        // 5. Only id, the CURRENT role and programme are passed on to the routes.
        //    programmeId limits what a reviewer can see (utils/reviewers.js).
        req.user = { id: user.id, role: user.role, programmeId: user.programme_id };
        req.sessionStart = decoded.sessionStart ?? decoded.iat; // used by the refresh route

        next(); // let the request continue to the actual route
    } catch (err) {
        console.error('❌ Token user check failed:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not check your session');
    }
}

module.exports = verifyToken;
