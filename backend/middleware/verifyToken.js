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
        const result = await pool.query('SELECT id, role FROM users WHERE id = $1', [decoded.id]);
        if (result.rows.length === 0) {
            return sendError(res, 401, 'ACCOUNT_GONE', 'Account no longer exists');
        }

        // 5. Only id and the CURRENT role are passed on to the routes
        req.user = { id: result.rows[0].id, role: result.rows[0].role };
        req.sessionStart = decoded.sessionStart ?? decoded.iat; // used by the refresh route

        next(); // let the request continue to the actual route
    } catch (err) {
        console.error('❌ Token user check failed:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not check your session');
    }
}

module.exports = verifyToken;
