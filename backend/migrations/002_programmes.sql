-- 002: study programmes (Group 2). Every student belongs to one programme; PTE target
-- courses and applications are tagged with it, so applications can be routed to that
-- programme's reviewer.
--
-- Adds required columns, so it needs empty dev data. On a database with existing rows,
-- run first:  npm run reset:dev -- --yes   (then npm run migrate, then npm run seed:dev)

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM courses)
       OR EXISTS (SELECT 1 FROM applications)
       OR EXISTS (SELECT 1 FROM users WHERE role = 'student') THEN
        RAISE EXCEPTION 'Migration 002 needs empty courses, applications and student accounts. Run "npm run reset:dev -- --yes" first, then "npm run migrate" and "npm run seed:dev".';
    END IF;
END $$;

-- Fixed list from the faculty: data, not configuration. Names are columns (not frontend
-- translation keys) because the backend needs them too, and a new programme needs no code change.
CREATE TABLE programmes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,   -- stable identifier, e.g. 'CS'
    name_en TEXT NOT NULL,
    name_hu TEXT NOT NULL,
    name_de TEXT NOT NULL
);

INSERT INTO programmes (code, name_en, name_hu, name_de) VALUES
    ('CS',    'Computer Science Engineering', 'Mérnökinformatikus', 'Ingenieurinformatik'),
    ('CIVIL', 'Civil Engineering',            'Építőmérnök',        'Bauingenieurwesen');

-- Users: Neptun code and programme are required for students. Other roles may have a
-- programme too (reviewers get one in the reviewer round).
ALTER TABLE users
    ADD COLUMN neptun_code VARCHAR(6) UNIQUE,
    ADD COLUMN programme_id INTEGER REFERENCES programmes(id),
    ADD CONSTRAINT users_neptun_code_format CHECK (neptun_code ~ '^[A-Z0-9]{6}$'),
    ADD CONSTRAINT users_students_have_profile
        CHECK (role <> 'student' OR (neptun_code IS NOT NULL AND programme_id IS NOT NULL));

-- PTE target courses belong to one programme. The same code may exist once per programme
-- (e.g. a maths course in two programmes' Neptun imports).
ALTER TABLE courses
    ADD COLUMN programme_id INTEGER NOT NULL REFERENCES programmes(id),
    DROP CONSTRAINT courses_university_id_course_code_key,
    ADD CONSTRAINT courses_university_programme_code_key UNIQUE (university_id, programme_id, course_code);

-- Applications: the student's programme at submission time, and the chosen target courses
-- as a snapshot read from the database: [{ "course_id", "course_code", "course_name", "credits" }].
-- The snapshot keeps old applications unchanged when courses are re-imported later.
ALTER TABLE applications
    ADD COLUMN programme_id INTEGER NOT NULL REFERENCES programmes(id),
    ADD COLUMN target_courses JSONB NOT NULL;

COMMENT ON COLUMN applications.pte_course_names IS
    'Legacy text list of target courses, filled from target_courses. Drop after the reviewer and admin rounds.';

CREATE INDEX users_programme_id_idx ON users (programme_id);
CREATE INDEX courses_programme_id_idx ON courses (programme_id);
CREATE INDEX applications_programme_id_idx ON applications (programme_id);
