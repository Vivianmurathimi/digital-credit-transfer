-- 001: the schema as it was before migrations were introduced (end of Group 1).
-- Replaces the old init-*.js scripts and the startup checks in server.js.
-- Everything is "IF NOT EXISTS", so on an existing database this changes nothing,
-- and on an empty one it builds the full schema.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'student',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_verified BOOLEAN DEFAULT false,
    verification_token VARCHAR(255),
    reset_password_token VARCHAR(255),
    reset_password_expires BIGINT,
    preferred_language VARCHAR(5) DEFAULT 'hu'
);

CREATE TABLE IF NOT EXISTS universities (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    country TEXT
);

CREATE TABLE IF NOT EXISTS courses (
    id SERIAL PRIMARY KEY,
    university_id INTEGER REFERENCES universities(id) ON DELETE CASCADE,
    course_code TEXT NOT NULL,
    course_name TEXT NOT NULL,
    credits INTEGER NOT NULL,
    UNIQUE (university_id, course_code)
);

CREATE TABLE IF NOT EXISTS applications (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES users(id),
    fulfilled_courses_json JSONB,
    pte_course_names TEXT,
    system_note TEXT,
    student_note TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    reviewer_note TEXT,
    student_resubmit_note TEXT,
    supplemental_files TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP
);

-- One row only: whether students may submit
CREATE TABLE IF NOT EXISTS system_settings (
    id SERIAL PRIMARY KEY,
    is_submissions_open BOOLEAN DEFAULT true
);

INSERT INTO system_settings (is_submissions_open)
SELECT true
WHERE NOT EXISTS (SELECT 1 FROM system_settings);

-- Rate limiting for public routes that send email (see utils/rateLimit.js)
CREATE TABLE IF NOT EXISTS rate_limit_hits (
    id BIGSERIAL PRIMARY KEY,
    bucket VARCHAR(32) NOT NULL,
    key_hash CHAR(64) NOT NULL,
    hit_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limit_hits_lookup ON rate_limit_hits (bucket, key_hash, hit_at);
