require('dotenv').config();

// The MinIO buckets, in one place. Normally "transcripts" (students' evidence) and "archives"
// (term book PDFs); the defence demo uses its own (npm run demo:start), so the development files
// are never touched. A bucket name must follow the S3 rules, or the server refuses to start.

const BUCKET_NAME_RULE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const readBucket = (name, fallback) => {
    const value = (process.env[name] || '').trim() || fallback;
    if (!BUCKET_NAME_RULE.test(value)) throw new Error(`${name} in backend/.env is not a valid bucket name: "${value}"`);
    return value;
};

const EVIDENCE_BUCKET = readBucket('MINIO_BUCKET', 'transcripts');
const ARCHIVE_BUCKET = readBucket('MINIO_ARCHIVE_BUCKET', 'archives');

module.exports = { EVIDENCE_BUCKET, ARCHIVE_BUCKET };
