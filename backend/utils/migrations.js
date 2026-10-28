const fs = require('fs');
const path = require('path');
const pool = require('../db');

// Schema changes live in backend/migrations as numbered .sql files (001_..., 002_...).
// schema_migrations records which ones have run, so each runs exactly once.

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const ensureMigrationsTable = () => pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);

// All migration files, in order
const listMigrationFiles = () => fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_[\w-]+\.sql$/.test(file))
    .sort();

// File names not applied yet (read-only: does not create schema_migrations)
const listPendingMigrations = async () => {
    const exists = (await pool.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
    const applied = exists
        ? new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
        : new Set();
    return listMigrationFiles().filter((file) => !applied.has(file));
};

/**
 * Applies every pending migration, each in its own transaction:
 * a migration either applies completely or not at all.
 * A lock stops two runs (e.g. two terminals) from migrating at the same time.
 * @returns {Promise<string[]>} the file names that were applied
 */
const runPendingMigrations = async () => {
    await ensureMigrationsTable();
    const client = await pool.connect();
    const done = [];
    try {
        await client.query("SELECT pg_advisory_lock(hashtext('schema_migrations'))");
        const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
        for (const file of listMigrationFiles()) {
            if (applied.has(file)) continue;
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
                await client.query('COMMIT');
                done.push(file);
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                throw new Error(`${file} failed and was rolled back: ${err.message}`);
            }
        }
    } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext('schema_migrations'))").catch(() => {});
        client.release();
    }
    return done;
};

module.exports = { listPendingMigrations, runPendingMigrations };
