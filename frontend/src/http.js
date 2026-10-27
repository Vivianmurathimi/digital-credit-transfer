import ky from 'ky';
import { getToken, handleAuthFailure } from './session';

// Backend address from the env file (REACT_APP_ prefix is required by Create React App).
// Without it, requests go to /api on the same origin as the page.
const API_ORIGIN = (process.env.REACT_APP_API_URL || '').replace(/\/+$/, '');
export const API_PREFIX = `${API_ORIGIN}/api`;

// The backend's { error, code } body, if the response has one
const readErrorCode = async (response) => {
    if (!(response.headers.get('content-type') || '').includes('application/json')) return null;
    try {
        const body = await response.json(); // ky hands this hook a clone, so reading it is safe
        return body && typeof body.code === 'string' ? body.code : null;
    } catch {
        return null;
    }
};

/**
 * The shared HTTP client for the app.
 * Usage: http.get('applications/mine').json()   ->  GET <API_PREFIX>/applications/mine
 *
 * Errors: ky throws an HTTPError whose `data` is the backend's { error, code },
 * which getErrorMessage translates. Without a connection it throws a NetworkError
 * (no `response`), shown as "Cannot connect to server".
 */
const http = ky.create({
    prefix: API_PREFIX,
    timeout: 30000, // 30 s per request; long jobs can pass their own timeout
    retry: 0,       // same as the old axios client: never repeat a request on its own

    hooks: {
        // Every request carries the current token (read fresh, so a renewed token is used at once)
        beforeRequest: [
            ({ request }) => {
                const token = getToken();
                if (token) request.headers.set('Authorization', `Bearer ${token}`);
            },
        ],

        // 401 -> log out (except a wrong password); 403 FORBIDDEN_ROLE -> "not allowed" banner
        afterResponse: [
            async ({ response }) => {
                if (response.status === 401 || response.status === 403) {
                    handleAuthFailure(response.status, await readErrorCode(response));
                }
            },
        ],
    },
});

export default http;
