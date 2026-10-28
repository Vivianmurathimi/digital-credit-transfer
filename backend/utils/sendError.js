// One error format for every route: { error: 'English message', code: 'MACHINE_CODE' }
// The frontend translates by `code`; `error` is the English fallback (and what shows in logs).
//
// Forms can also get field-level errors (optional, so every existing page keeps working):
//   field:  path of the first problem in the request JSON, e.g. 'fulfilled_courses[1].credits'
//   errors: every problem found: [{ field, code, error, params }]
// Paths and messages are built by the server from known field names and numbers only;
// nothing the user typed is ever echoed back.
const sendError = (res, status, code, message, { field, errors } = {}) => {
    const body = { error: message, code };
    if (field) body.field = field;
    if (errors) body.errors = errors;
    return res.status(status).json(body);
};

const MAX_REPORTED_ERRORS = 50;

/**
 * Sends several field errors at once. The first one also fills the top-level error/code/field,
 * so pages that only read `code` still show a sensible message.
 * @param errors [{ field, code, message, params? }] in form order (params: numbers for the message)
 */
const sendValidationErrors = (res, errors, status = 400) => {
    const list = errors.slice(0, MAX_REPORTED_ERRORS).map(({ field, code, message, params }) => (
        params ? { field, code, error: message, params } : { field, code, error: message }
    ));
    const [first] = list;
    return sendError(res, status, first.code, first.error, { field: first.field, errors: list });
};

module.exports = sendError;
module.exports.sendValidationErrors = sendValidationErrors;
