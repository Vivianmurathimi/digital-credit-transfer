import axios from 'axios';
import { API_ORIGIN } from './http';
import { getToken, handleAuthFailure } from './session';

// The older axios client, still used by the admin dashboard and the term archive
// (the reviewer dashboard moved to the shared ky client in reviewer Group 3).
// It behaves like the shared ky client (src/http.js) until those dashboards move over.
// Same backend address as ky; the paths keep their /api/... prefix.
const api = axios.create({ baseURL: API_ORIGIN });

// Before every request goes out, attach the current token
api.interceptors.request.use((config) => {
    const token = getToken();
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// 401 -> log out with the reason (except a wrong password); 403 FORBIDDEN_ROLE -> "not allowed" banner
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response) {
            const code = error.response.data && typeof error.response.data.code === 'string' ? error.response.data.code : null;
            handleAuthFailure(error.response.status, code);
        }
        return Promise.reject(error);
    }
);

export default api;
