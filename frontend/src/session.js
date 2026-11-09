import { showNotice } from './notice';

// Everything about the login session lives here, so every part of the app
// (the ky client, the old axios client, the session keeper, Log Out) handles it the same way.

const TOKEN_KEY = 'token';
const ROLE_KEY = 'role';
// Only these keys belong to a session. Clearing them never touches other saved
// settings, such as the language the user picked (i18nextLng).
// The old "impersonation" keys (before admin round Group 1) are no longer read; they are only
// removed with the session, so a browser that still has them is cleaned up.
const OLD_IMPERSONATION_KEYS = ['originalRole', 'impersonatedRole', 'impersonatedUserId', 'impersonatedName'];
const SESSION_KEYS = [TOKEN_KEY, ROLE_KEY, ...OLD_IMPERSONATION_KEYS];

export const VALID_ROLES = ['student', 'reviewer', 'superadmin'];

// Reasons the login page may show after ?reason=. Anything else in the address is ignored,
// because anyone can type a ?reason= value into the URL.
export const SESSION_END_CODES = ['NO_TOKEN', 'TOKEN_EXPIRED', 'INVALID_TOKEN', 'SESSION_TOO_OLD', 'ACCOUNT_GONE', 'REVIEWER_REMOVED', 'ACTING_ENDED', 'ACCOUNT_DEACTIVATED'];

// Pages anyone can open, logged in or not. Links from emails (verify, reset, email link)
// must keep working even with an old session in the browser. Kept in this one place
// so a page added later is not forgotten (the session keeper reads it).
export const PUBLIC_PAGES = ['/login', '/register', '/forgot-password', '/reset-password/', '/verify/', '/email-link/', '/invite/'];

export const isPublicPage = (pathname) =>
    PUBLIC_PAGES.some((page) => (page.endsWith('/') ? pathname.startsWith(page) : pathname === page));

// The token is treated as expired this much before its real expiry, so a slightly
// wrong computer clock never lets an expired token through
const CLOCK_MARGIN_MS = 30 * 1000;
// Same hard limit as the backend (config/jwt.js MAX_SESSION_SECONDS)
const MAX_SESSION_MS = 8 * 60 * 60 * 1000;

// localStorage can throw (private mode, blocked storage), so every access is guarded
const read = (key) => {
    try { return localStorage.getItem(key); } catch { return null; }
};

export const getToken = () => read(TOKEN_KEY);

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

// Usable time left on a token payload (clock margin already taken off)
const msLeft = (payload, now) => payload.exp * 1000 - CLOCK_MARGIN_MS - now;

// Milliseconds until the token should be treated as expired (<= 0 once it is);
// null without a usable token
export const msUntilExpiry = () => {
    const payload = readTokenPayload();
    return payload && payload.exp ? msLeft(payload, Date.now()) : null;
};

/**
 * The guard rules as a plain function (no React, no storage), so they can be tested on their own.
 * Input: the raw token and the current time.
 *
 * Returns { valid: false, reason } or { valid: true, user, view }:
 * - user: the account the session is for, read from the TOKEN (not the separate 'role' key,
 *   which anyone can edit)
 * - view: whose dashboard to show. While the admin acts as a student or reviewer (admin round
 *   Group 1) the token itself is that person's, plus `acting` ({ sessionId, actorId, name }),
 *   which the server issued; then `acting` is true and `name` is the person's name for the banner.
 *
 * This only decides which screens to show. The backend checks every request itself.
 */
export const evaluateSession = ({ token, now = Date.now() }) => {
    if (!token) return { valid: false, reason: null };

    const payload = readTokenPayload(token);
    if (!payload || !payload.id || !payload.exp || !VALID_ROLES.includes(payload.role)) {
        return { valid: false, reason: 'INVALID_TOKEN' };
    }
    if (msLeft(payload, now) <= 0) return { valid: false, reason: 'TOKEN_EXPIRED' };

    const startedAt = (payload.sessionStart ?? payload.iat) * 1000;
    if (now - startedAt > MAX_SESSION_MS) return { valid: false, reason: 'SESSION_TOO_OLD' };

    const user = { id: payload.id, role: payload.role };
    // Only a student or reviewer session can be an acting one (the server never issues another)
    const acting = !!payload.acting && ['student', 'reviewer'].includes(payload.role);
    const view = { userId: user.id, role: user.role, name: acting ? String(payload.acting.name || '') : '', acting };

    return { valid: true, user, view };
};

// evaluateSession for the session saved in this browser
export const getSessionState = () => evaluateSession({ token: getToken() });

// True while the admin acts as someone (the banner, and nothing saved to that person's profile)
export const isActing = () => !!readTokenPayload()?.acting;

// Removes stored keys without leaving the page
const removeKeys = (keys) => keys.forEach((key) => {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
});

// Ends the session quietly (no redirect), e.g. an expired token on a public page
export const forgetSession = () => removeKeys(SESSION_KEYS);

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

    forgetSession();
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
