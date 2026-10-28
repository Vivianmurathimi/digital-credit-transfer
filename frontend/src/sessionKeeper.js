import http from './http';
import { clearSession, forgetSession, isPublicPage, msUntilExpiry, readTokenPayload, saveSession } from './session';

// Keeps an active user logged in and ends the session after real inactivity.
// Tokens last 30 minutes; while the user is active a fresh one is fetched shortly before expiry.

const CHECK_EVERY_MS = 60 * 1000;          // look at the token once a minute
const RENEW_WHEN_LEFT_MS = 5 * 60 * 1000;  // renew when less than 5 minutes are left...
const IDLE_LIMIT_MS = 30 * 60 * 1000;      // ...but only if the user did something in the last 30 minutes

// Mouse, keyboard, touch and scrolling all count as activity (drawing on the highlighter too)
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll', 'touchstart'];

let lastActivity = Date.now();
let timer = null;
let isRenewing = false;

// Kept as cheap as possible: it runs on every mouse move, so it only stores a timestamp
const markActive = () => {
    lastActivity = Date.now();
};

const renew = async () => {
    isRenewing = true;
    try {
        const previousRole = readTokenPayload()?.role;
        const { token, role } = await http.post('refresh-token').json();
        saveSession(token, role);
        // The admin changed this user's role: reload so the matching dashboard is shown
        if (previousRole && role !== previousRole) window.location.reload();
    } catch {
        // A 401 is already handled by the http client (logout with the reason).
        // A network problem is simply retried at the next check.
    } finally {
        isRenewing = false;
    }
};

const check = () => {
    const left = msUntilExpiry();
    if (left === null) return; // not logged in

    if (left <= 0) {
        // On a public page (e.g. a reset link from an email) just forget the old session,
        // so the page keeps working; anywhere else, log out with the reason
        if (isPublicPage(window.location.pathname)) forgetSession();
        else clearSession('TOKEN_EXPIRED');
        return;
    }

    const recentlyActive = Date.now() - lastActivity < IDLE_LIMIT_MS;
    if (left < RENEW_WHEN_LEFT_MS && recentlyActive && !isRenewing) {
        renew();
    }
};

// Check straight away when the tab comes back (e.g. after the laptop was asleep)
const onVisible = () => {
    if (document.visibilityState === 'visible') check();
};

// Started once by App; safe to call again
export const startSessionKeeper = () => {
    if (timer) return;
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, markActive, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', onVisible);
    timer = setInterval(check, CHECK_EVERY_MS);
    check();
};

export const stopSessionKeeper = () => {
    if (!timer) return;
    ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, markActive, { capture: true }));
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
    timer = null;
};
