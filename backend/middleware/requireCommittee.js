const sendError = require('../utils/sendError');

/**
 * Committee routes (round 2 Group 2): anyone with committee access. A committee member (role
 * 'committee'; with no current programme they simply see nothing), or a reviewer who has at least one
 * current committee link. The links are read from the database on every request (verifyToken).
 * Everyone else: 403 FORBIDDEN_ROLE, like requireRole.
 */
const requireCommittee = (req, res, next) => {
    if (!req.user) return sendError(res, 401, 'NO_TOKEN', 'Not authenticated');
    const user = req.user;
    const allowed = user.role === 'committee' || (user.role === 'reviewer' && (user.committeeProgrammeIds || []).length > 0);
    if (!allowed) return sendError(res, 403, 'FORBIDDEN_ROLE', 'Only committee members can do this');
    return next();
};

module.exports = requireCommittee;
