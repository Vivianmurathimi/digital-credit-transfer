const sendError = require('../utils/sendError');

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        // req.user was set by verifyToken, which must run BEFORE this
        if (!req.user) {
            return sendError(res, 401, 'NO_TOKEN', 'Not authenticated');
        }

        if (!allowedRoles.includes(req.user.role)) {
            return sendError(res, 403, 'FORBIDDEN_ROLE', 'You do not have permission to do this');
        }

        next(); // role is allowed, let the request continue
    };
}

module.exports = requireRole;