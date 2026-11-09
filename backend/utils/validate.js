const sendError = require('./sendError');

// Small input checks shared by the admin routes (admin round Group 1), so bad input gets a clear
// 400 instead of reaching the database (where e.g. id "abc" would be a 500).

// A positive whole number (from a URL parameter, query or JSON body), or null.
// Accepts 5 and "5"; refuses "5abc", "5.0", "-1", "", null, true.
const positiveInt = (value) => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
    if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
        const number = Number(value);
        return Number.isSafeInteger(number) ? number : null;
    }
    return null;
};

/**
 * Express middleware: refuses the request with 400 unless the URL parameter is a positive whole
 * number, and stores the number in req.ids[name].
 */
const requireIdParam = (name = 'id') => (req, res, next) => {
    const id = positiveInt(req.params[name]);
    if (id === null) {
        return sendError(res, 400, 'INVALID_ID', `${name} must be a positive whole number`, { field: name });
    }
    req.ids = { ...(req.ids || {}), [name]: id };
    return next();
};

module.exports = { positiveInt, requireIdParam };
