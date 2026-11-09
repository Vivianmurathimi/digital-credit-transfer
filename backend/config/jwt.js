require('dotenv').config();
const jwt = require('jsonwebtoken');

// One place for every JWT setting, so login, verifyToken and email links can never disagree.

// No fallback: without a real secret anyone could forge an admin token, so refuse to start.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is missing from backend/.env — the server will not start without it.');
}

const ALGORITHM = 'HS256';

// Session rules:
// - IDLE_TIMEOUT: each token expires after 30 minutes. While the user is active the frontend
//   asks POST /api/refresh-token for a fresh one, so only real inactivity ends the session.
// - MAX_SESSION_SECONDS: even an active session ends 8 hours after login.
const IDLE_TIMEOUT = '30m';
const MAX_SESSION_SECONDS = 8 * 60 * 60;

/**
 * Signs a session token. `sessionStart` (seconds) is the original login time and is
 * carried over unchanged on every refresh, so the 8-hour limit cannot be extended.
 */
const signSessionToken = ({ id, role }, sessionStart = Math.floor(Date.now() / 1000), acting = null) =>
    jwt.sign(acting ? { id, role, sessionStart, acting } : { id, role, sessionStart }, JWT_SECRET, { algorithm: ALGORITHM, expiresIn: IDLE_TIMEOUT });

// The admin acting as a student or reviewer (admin round Group 1): the token is that person's
// (id, role), plus `acting`: { sessionId, actorId, name } (the acting_sessions row, the real admin,
// and the person's name for the banner). verifyToken re-checks the row on every request.
// An acting session lasts at most this long, and never past the admin's own 8-hour limit.
const MAX_ACTING_SECONDS = 60 * 60;

// Throws if the signature, algorithm or expiry is wrong (jsonwebtoken errors)
const verifySessionToken = (token) => jwt.verify(token, JWT_SECRET, { algorithms: [ALGORITHM] });

// True once 8 hours have passed since login. Tokens from before this change have no
// sessionStart, so their issue time is used instead.
const isSessionTooOld = (decoded) => {
    const startedAt = decoded.sessionStart ?? decoded.iat;
    return Math.floor(Date.now() / 1000) - startedAt > MAX_SESSION_SECONDS;
};

module.exports = {
    JWT_SECRET,
    ALGORITHM,
    IDLE_TIMEOUT,
    MAX_SESSION_SECONDS,
    MAX_ACTING_SECONDS,
    signSessionToken,
    verifySessionToken,
    isSessionTooOld,
};
