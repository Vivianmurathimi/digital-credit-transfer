const pool = require('../db');
const { verifySessionToken, isSessionTooOld } = require('../config/jwt');

async function verifyToken(req, res, next) {
    // 1. Look for "Authorization: Bearer <token>" (any capitalisation, extra spaces ignored)
    const match = /^\s*bearer\s+(\S+)\s*$/i.exec(req.headers['authorization'] || '');
    if (!match) {
        return res.status(401).json({ error: 'No token provided' });
    }

    // 2. Verify it's real, signed with our algorithm, and not expired/tampered
    let decoded;
    try {
        decoded = verifySessionToken(match[1]);
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // 3. Even an active session ends 8 hours after login
    if (isSessionTooOld(decoded)) {
        return res.status(401).json({ error: 'Session expired, please log in again' });
    }

    // 4. Re-check the user in the database, so a deleted user is refused and a
    //    role change by the admin takes effect immediately (not when the token expires)
    try {
        const result = await pool.query('SELECT id, role FROM users WHERE id = $1', [decoded.id]);
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Account no longer exists' });
        }

        // 5. Only id and the CURRENT role are passed on to the routes
        req.user = { id: result.rows[0].id, role: result.rows[0].role };
        req.sessionStart = decoded.sessionStart ?? decoded.iat; // used by the refresh route

        next(); // let the request continue to the actual route
    } catch (err) {
        console.error('❌ Token user check failed:', err.message);
        return res.status(500).json({ error: 'Could not check your session' });
    }
}

module.exports = verifyToken;
