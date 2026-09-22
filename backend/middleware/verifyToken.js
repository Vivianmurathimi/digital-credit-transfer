const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
    // 1. Look for the token in the Authorization header
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }

    // 2. Pull just the token part out of "Bearer <token>"
    const token = authHeader.split(' ')[1];

    try {
        // 3. Verify it's real and not expired/tampered
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');

        // 4. Attach the user info to the request so later code can use it
        req.user = decoded; // { id, role, iat, exp }

        next(); // let the request continue to the actual route
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

module.exports = verifyToken;