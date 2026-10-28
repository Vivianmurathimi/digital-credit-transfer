/**
 * Empties the development data (never in production):
 *   - applications, users, PTE courses, rate-limit counts
 *   - every evidence file in the "transcripts" bucket
 *
 *   npm run reset:dev -- --yes
 *
 * Keeps: programmes, universities, system settings, migration history and the
 * term-book archive bucket. Uses only tables from migration 001, so it also works
 * before migration 002 has run. Afterwards: npm run migrate, then npm run seed:dev.
 *
 * Ids are not restarted on purpose: a new account must never get the id of a
 * deleted one, because evidence files are tagged with their uploader's id.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. reset:dev deletes data and is for development only.');
    process.exit(1);
}
if (!process.argv.includes('--yes')) {
    console.error('This deletes ALL users, applications, courses and evidence files in the development database.');
    console.error('Run it with --yes to confirm:  npm run reset:dev -- --yes');
    process.exit(1);
}

const pool = require('../db');
const minioClient = require('../minio');

const EVIDENCE_BUCKET = 'transcripts';

const listEvidenceFiles = () => new Promise((resolve, reject) => {
    const names = [];
    const stream = minioClient.listObjects(EVIDENCE_BUCKET, '', true);
    stream.on('data', (obj) => names.push(obj.name));
    stream.on('end', () => resolve(names));
    stream.on('error', reject);
});

const reset = async () => {
    const client = await pool.connect();
    let counts;
    try {
        await client.query('BEGIN');
        // Children first: applications point to users
        const apps = await client.query('DELETE FROM applications');
        const users = await client.query('DELETE FROM users');
        const courses = await client.query('DELETE FROM courses');
        await client.query('DELETE FROM rate_limit_hits');
        await client.query('COMMIT');
        counts = { applications: apps.rowCount, users: users.rowCount, courses: courses.rowCount };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    const exists = await minioClient.bucketExists(EVIDENCE_BUCKET);
    const files = exists ? await listEvidenceFiles() : [];
    if (files.length > 0) await minioClient.removeObjects(EVIDENCE_BUCKET, files);

    console.log(`Deleted ${counts.applications} applications, ${counts.users} users, ${counts.courses} courses and ${files.length} evidence files.`);
    console.log('Next: npm run migrate, then npm run seed:dev');
};

reset()
    .then(() => process.exit(0)) // db.js keeps its startup test connection open
    .catch((err) => {
        console.error(`Reset failed: ${err.message}`);
        process.exit(1);
    });
