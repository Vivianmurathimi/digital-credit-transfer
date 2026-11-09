const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const { signSessionToken } = require('../config/jwt');
const { positiveInt } = require('../utils/validate');

// The admin acting as a student or reviewer (admin round Group 1).
//
// Start gives the admin a session token FOR that person, which also carries the admin's id and the
// acting_sessions row (config/jwt.js). verifyToken then sets req.user = the person and req.actor =
// the admin, so every student and reviewer route works as for the person, while every change is
// recorded as 'admin' with the admin's id. Exit closes the row and gives the admin's own session
// back. The session keeps the admin's original login time, so the 8-hour limit still applies.

// POST /api/acting/start { userId }: superadmin only (while acting, the role is the person's, so
// starting a second acting session from inside one is refused by requireRole with 403)
router.post('/acting/start', verifyToken, requireRole('superadmin'), async (req, res) => {
    const personId = positiveInt(req.body?.userId);
    if (personId === null) return sendError(res, 400, 'INVALID_USER_ID', 'userId must be a positive whole number', { field: 'userId' });

    try {
        const person = (await pool.query(
            'SELECT id, name, role, reviewer_deactivated_at FROM users WHERE id = $1', [personId]
        )).rows[0];
        if (!person) return sendError(res, 404, 'USER_NOT_FOUND', 'User not found');
        if (!['student', 'reviewer'].includes(person.role)) {
            return sendError(res, 400, 'CANNOT_ACT_AS_ROLE', 'You can only act as a student or a reviewer');
        }
        if (person.role === 'reviewer' && person.reviewer_deactivated_at) {
            return sendError(res, 400, 'CANNOT_ACT_AS_REMOVED_REVIEWER', 'This reviewer has been removed');
        }

        const sessionId = await inTransaction(async (client) => {
            // One acting session per admin at a time: an earlier one left open (e.g. a closed tab) ends now
            await client.query('UPDATE acting_sessions SET ended_at = now() WHERE admin_id = $1 AND ended_at IS NULL', [req.actor.id]);
            const { rows } = await client.query(
                'INSERT INTO acting_sessions (admin_id, person_id, person_role) VALUES ($1, $2, $3) RETURNING id',
                [req.actor.id, person.id, person.role]
            );
            return rows[0].id;
        });

        const acting = { sessionId, actorId: req.actor.id, name: person.name };
        const token = signSessionToken({ id: person.id, role: person.role }, req.sessionStart, acting);
        res.json({ success: true, token, role: person.role, name: person.name });
    } catch (err) {
        console.error('❌ Start acting error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not start acting as this user');
    }
});

// POST /api/acting/exit: only with an acting token. Ends the session on the server (the acting
// token is refused from now on) and returns the admin's own token.
router.post('/acting/exit', verifyToken, async (req, res) => {
    if (!req.acting) return sendError(res, 400, 'NOT_ACTING', 'You are not acting as anyone');

    try {
        await pool.query('UPDATE acting_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL', [req.acting.sessionId]);
        const token = signSessionToken({ id: req.actor.id, role: 'superadmin' }, req.sessionStart);
        res.json({ success: true, token, role: 'superadmin' });
    } catch (err) {
        console.error('❌ Exit acting error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not end the acting session');
    }
});

module.exports = router;
