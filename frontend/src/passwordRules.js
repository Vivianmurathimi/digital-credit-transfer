// The password rule, the same number as the backend (backend/utils/passwordRules.js, which
// always checks it too). Used by the reviewer invite page; registration can use it later.
export const MIN_PASSWORD_LENGTH = 8;

// Counted in characters, like the backend ("é" is one)
export const isPasswordLongEnough = (password) => [...password].length >= MIN_PASSWORD_LENGTH;
