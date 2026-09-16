function requireRole(...allowedRoles) {
    return (req, res, next) => {
        // req.user was set by verifyToken, which must run BEFORE this
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: 'You do not have permission to do this' });
        }

        next(); // role is allowed, let the request continue
    };
}

module.exports = requireRole;