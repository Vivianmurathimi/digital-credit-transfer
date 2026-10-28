require('dotenv').config();

// One place for the addresses the backend needs: links in emails and the CORS allow-list.

const isProduction = process.env.NODE_ENV === 'production';
const DEV_FRONTEND_URL = 'http://localhost:3000';

// Browsers send the Origin as scheme://host:port, so settings are reduced to that form.
// A typo here would silently break emails or CORS, so a malformed address stops the server.
const toOrigin = (value, name) => {
    try {
        return new URL(value.trim()).origin;
    } catch {
        throw new Error(`${name} in backend/.env is not a valid address: "${value}"`);
    }
};

const readFrontendUrl = () => {
    const value = (process.env.FRONTEND_URL || '').trim().replace(/\/+$/, '');
    if (value) {
        toOrigin(value, 'FRONTEND_URL'); // validate only; links keep any path, e.g. /credit-transfer
        return value;
    }
    // Production must say where the frontend lives, or every email link would point to localhost
    if (isProduction) {
        throw new Error('FRONTEND_URL is missing from backend/.env — the server will not start without it in production.');
    }
    console.warn(`⚠️  FRONTEND_URL is not set; using ${DEV_FRONTEND_URL} (development only).`);
    return DEV_FRONTEND_URL;
};

// Base address of the frontend, without a trailing slash (used in email links)
const FRONTEND_URL = readFrontendUrl();

// Websites allowed to call the API from a browser: the frontend, plus any extra
// comma-separated addresses in CORS_ORIGINS (e.g. a second domain)
const CORS_ORIGINS = [
    toOrigin(FRONTEND_URL, 'FRONTEND_URL'),
    ...(process.env.CORS_ORIGINS || '').split(',').filter((v) => v.trim()).map((v) => toOrigin(v, 'CORS_ORIGINS')),
];

module.exports = { FRONTEND_URL, CORS_ORIGINS };
