const crypto = require('crypto');
const pool = require('../db');
const { JWT_SECRET } = require('../config/jwt');

// Limits for the public routes that send email (forgot password, register).
// Counts live in PostgreSQL, so they survive a server restart and are shared by
// every backend process. Any future public route that sends email (e.g. "resend
// verification") must use takeSlot as well.

const readLimit = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} in backend/.env must be a whole number of at least 1, got "${raw}"`);
    }
    return value;
};

const LIMITS = {
    forgotPerEmail: readLimit('RATE_LIMIT_FORGOT_PER_EMAIL', 3),
    forgotPerIp: readLimit('RATE_LIMIT_FORGOT_PER_IP', 30),
    registerPerIp: readLimit('RATE_LIMIT_REGISTER_PER_IP', 30),
};

// Addresses and IPs are stored only as an HMAC, so the table never lists what people typed.
// The key comes from JWT_SECRET: changing the secret starts all counts from zero.
const HASH_KEY = crypto.createHash('sha256').update(`${JWT_SECRET}_rate_limit`).digest();
const hashKey = (value) => crypto.createHmac('sha256', HASH_KEY).update(String(value)).digest('hex');

// One spelling per address, so "A@x.hu " and "a@x.hu" share a count
const normalizeEmail = (email) => email.trim().toLowerCase();

// The caller's IP. "::ffff:127.0.0.1" and "127.0.0.1" are the same address.
// Behind a reverse proxy this is only correct with TRUST_PROXY set (see server.js).
const clientIp = (req) => (req.ip || '').replace(/^::ffff:/, '');

const ensureRateLimitTable = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS rate_limit_hits (
                id BIGSERIAL PRIMARY KEY,
                bucket VARCHAR(32) NOT NULL,
                key_hash CHAR(64) NOT NULL,
                hit_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );`);
        await pool.query('CREATE INDEX IF NOT EXISTS rate_limit_hits_lookup ON rate_limit_hits (bucket, key_hash, hit_at);');
        console.log('✅ Ensured rate_limit_hits table');
    } catch (err) {
        console.error('❌ Could not ensure rate_limit_hits table:', err.message);
    }
};

// Old rows are removed now and then (at most every 10 minutes), never on every request
let lastCleanup = 0;
const cleanupOldHits = () => {
    if (Date.now() - lastCleanup < 10 * 60 * 1000) return;
    lastCleanup = Date.now();
    pool.query("DELETE FROM rate_limit_hits WHERE hit_at < now() - interval '1 hour'")
        .catch((err) => console.error('Rate limit cleanup error:', err.message));
};

/**
 * Takes one slot in a bucket if fewer than `limit` were taken in the last hour.
 * The check and the insert run in one transaction under a lock on this bucket+key,
 * so simultaneous requests can never go over the limit.
 * Only taken slots are stored: refused requests do not extend the block.
 * @returns {Promise<boolean>} true = allowed (slot taken), false = over the limit
 */
const takeSlot = async (bucket, value, limit) => {
    cleanupOldHits();
    const keyHash = hashKey(value);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${bucket}:${keyHash}`]);
        const { rows } = await client.query(
            "SELECT count(*)::int AS hits FROM rate_limit_hits WHERE bucket = $1 AND key_hash = $2 AND hit_at > now() - interval '1 hour'",
            [bucket, keyHash]
        );
        const allowed = rows[0].hits < limit;
        if (allowed) {
            await client.query('INSERT INTO rate_limit_hits (bucket, key_hash) VALUES ($1, $2)', [bucket, keyHash]);
        }
        await client.query('COMMIT');
        return allowed;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

module.exports = { LIMITS, takeSlot, hashKey, normalizeEmail, clientIp, ensureRateLimitTable };
