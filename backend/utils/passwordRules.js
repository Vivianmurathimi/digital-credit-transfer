// The password rule, in one place (reviewer Group 2). Used by the reviewer invite page;
// student registration and password reset can use it later.
// The frontend shows the same number from frontend/src/passwordRules.js: keep them equal.

const MIN_PASSWORD_LENGTH = 8;

/**
 * @returns {null | { code: string, message: string, params: { min: number } }} null when the password is fine
 */
const checkPassword = (password) => {
    // Counted in characters, not bytes ("é" is one)
    if (typeof password !== 'string' || [...password].length < MIN_PASSWORD_LENGTH) {
        return {
            code: 'PASSWORD_TOO_SHORT',
            message: `The password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
            params: { min: MIN_PASSWORD_LENGTH },
        };
    }
    return null;
};

module.exports = { MIN_PASSWORD_LENGTH, checkPassword };
