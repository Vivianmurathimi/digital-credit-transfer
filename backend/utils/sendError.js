// One error format for every route: { error: 'English message', code: 'MACHINE_CODE' }
// The frontend translates by `code`; `error` is the English fallback (and what shows in logs).
const sendError = (res, status, code, message) => res.status(status).json({ error: message, code });

module.exports = sendError;
