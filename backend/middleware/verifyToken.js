const pool = require('../db');
const { verifySessionToken, isSessionTooOld, MAX_ACTING_SECONDS } = require('../config/jwt');
const sendError = require('../utils/sendError');
const { visibleProgrammeIds, committeeProgrammeIds } = require('../utils/reviewers');

/**
 * An acting token is accepted only while its acting_sessions row is open (Exit closes it), younger
 * than MAX_ACTING_SECONDS, for the same admin and person, the admin is still a superadmin, and the
 * person is still a student or an active reviewer (the reviewer check is step 4 above).
 * @returns {Promise<string|null>} the refusal code, or null when the session is fine
 */
async function checkActingSession(acting, person) {
    const { rows } = await pool.query(
        `SELECT s.admin_id, s.person_id, s.person_role, s.ended_at,
                s.started_at < now() - make_interval(secs => $2) AS too_old, a.role AS admin_role, a.deactivated_at AS admin_deactivated_at
         FROM acting_sessions s JOIN users a ON a.id = s.admin_id
         WHERE s.id = $1`,
        [Number(acting.sessionId) || 0, MAX_ACTING_SECONDS]
    );
    const session = rows[0];
    if (session && !session.ended_at && session.too_old) {
        // Ran out of time without Exit: close the log entry at the moment it ended
        await pool.query(
            'UPDATE acting_sessions SET ended_at = started_at + make_interval(secs => $2) WHERE id = $1 AND ended_at IS NULL',
            [Number(acting.sessionId), MAX_ACTING_SECONDS]
        );
    }
    if (!session || session.ended_at || session.too_old) return 'ACTING_ENDED';
    if (session.admin_id !== acting.actorId || session.person_id !== person.id || session.person_role !== person.role) return 'ACTING_ENDED';
    if (session.admin_role !== 'superadmin' || session.admin_deactivated_at) return 'ACTING_ENDED';
    return null;
}

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
        const result = await pool.query('SELECT id, role, deactivated_at FROM users WHERE id = $1', [decoded.id]);
        if (result.rows.length === 0) {
            return sendError(res, 401, 'ACCOUNT_GONE', 'Account no longer exists');
        }
        const user = result.rows[0];
        // A removed reviewer (reviewer Group 2) or deactivated admin (admin round Group 2) is
        // refused on every request, from the next one on. While the admin acts as that person,
        // it is the acting session that ends (the admin is not told "your access was removed").
        if (user.deactivated_at) {
            if (decoded.acting) return sendError(res, 401, 'ACTING_ENDED', 'The acting session has ended');
            return user.role === 'reviewer'
                ? sendError(res, 401, 'REVIEWER_REMOVED', 'Your reviewer access has been removed')
                : sendError(res, 401, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
        }

        // 5. Only id, the CURRENT role and, for a reviewer, the programmes they may see NOW are
        //    passed on to the routes (staff_programmes, read on every request: round 2 Group 1).
        //    programmeIds limits what a reviewer can see (utils/reviewers.js).
        req.user = { id: user.id, role: user.role };
        if (user.role === 'reviewer') req.user.programmeIds = await visibleProgrammeIds(pool, user.id);
        // Committee access (round 2 Group 2): from the current committee links, for a committee
        // member and for a reviewer who also sits on a committee
        if (user.role === 'reviewer' || user.role === 'committee') req.user.committeeProgrammeIds = await committeeProgrammeIds(pool, user.id);
        req.sessionStart = decoded.sessionStart ?? decoded.iat; // used by the refresh route

        // 6. Who really acts. Normally the user themselves. While the superadmin acts as a student
        //    or reviewer (admin round Group 1), req.user is that person (so every route works for
        //    them unchanged) and req.actor is the admin: what is done is recorded as the admin.
        req.actor = { id: user.id, role: user.role };
        req.acting = null;
        if (decoded.acting) {
            const refusal = await checkActingSession(decoded.acting, user);
            if (refusal) return sendError(res, 401, refusal, 'The acting session has ended');
            req.actor = { id: decoded.acting.actorId, role: 'superadmin' };
            req.acting = decoded.acting;
        }

        next(); // let the request continue to the actual route
    } catch (err) {
        console.error('❌ Token user check failed:', err.message);
        return sendError(res, 500, 'SERVER_ERROR', 'Could not check your session');
    }
}

module.exports = verifyToken;
