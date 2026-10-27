import { showNotice } from './notice';

// Everything about the login session lives here, so every part of the app
// (the ky client, the old axios client, the session keeper, Log Out) handles it the same way.

const TOKEN_KEY = 'token';
const ROLE_KEY = 'role';
// Only these keys belong to a session. Clearing them never touches other saved
// settings, such as the language the user picked (i18nextLng).
const SESSION_KEYS = [TOKEN_KEY, ROLE_KEY, 'originalRole', 'impersonatedRole', 'impersonatedUserId', 'impersonatedName'];

// localStorage can throw (private mode, blocked storage), so every access is guarded
const read = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
};

export const getToken = () => read(TOKEN_KEY);
export const getRole = () => read(ROLE_KEY);

export const saveSession = (token, role) => {
    try {
        localStorage.setItem(TOKEN_KEY, token);
        if (role) localStorage.setItem(ROLE_KEY, role);
    } catch { /* storage blocked: the session simply won't survive a reload */ }
};

/**
 * Reads the token's payload WITHOUT verifying it. Only used for timing (when does it
 * expire?) and for the logged-in user's id. The backend always does the real check.
 */
export const readTokenPayload = (token = getToken()) => {
    if (!token) return null;
    try {
        const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')));
    } catch {
        return null;
    }
};

// Milliseconds until the token expires (negative once expired); null without a usable token
export const msUntilExpiry = () => {
    const payload = readTokenPayload();
    return payload && payload.exp ? payload.exp * 1000 - Date.now() : null;
};

// Several requests can fail with 401 at the same moment; only the first one redirects
let isRedirecting = false;

/**
 * Ends the session and goes to the login page.
 * `reasonCode` is a backend error code (e.g. TOKEN_EXPIRED); the login page translates it.
 * A full page load is used on purpose: it also stops timers and clears in-memory state.
 */
export const clearSession = (reasonCode = null) => {
    if (isRedirecting) return;
    isRedirecting = true;

    SESSION_KEYS.forEach((key) => {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
    });

    const target = reasonCode ? `/login?reason=${encodeURIComponent(reasonCode)}` : '/login';
    window.location.replace(target);
};

/**
 * Shared reaction to a failed request, used by both the ky client and the axios bridge:
 * - 401: log out with the reason, EXCEPT a wrong password on the login page (INVALID_CREDENTIALS)
 * - 403 FORBIDDEN_ROLE: generic "You are not allowed to do this." banner
 * - every other error is left to the page, which shows its own translated message
 */
export const handleAuthFailure = (status, code) => {
    if (status === 401 && code !== 'INVALID_CREDENTIALS') {
        clearSession(code);
    } else if (status === 403 && code === 'FORBIDDEN_ROLE') {
        showNotice('FORBIDDEN_ROLE');
    }
};
