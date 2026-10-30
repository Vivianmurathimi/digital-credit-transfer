-- 008: semesters and the application period (Group 3).
--
-- A semester has an application period (first and last day students can submit) and an end
-- (its last day). All three are calendar days in Budapest; the exact moments are worked out
-- with the database's time-zone rules (semester_bounds below), never with a fixed offset.
-- Semesters can't overlap, so at most one is current at any moment.
--
-- Courses and applications belong to a semester. Rows from before this migration have none
-- ("before semesters"); `npm run semester:create` adds courses without a semester to the new one.

CREATE TABLE semesters (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    applications_open_on DATE NOT NULL,
    applications_close_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT semesters_dates_in_order CHECK (applications_open_on <= applications_close_on AND applications_close_on <= ends_on),
    -- From the first application day to the last semester day: never two semesters at once
    CONSTRAINT semesters_no_overlap EXCLUDE USING gist (daterange(applications_open_on, ends_on, '[]') WITH &&)
);

COMMENT ON TABLE semesters IS 'Semesters and their application periods. Created with npm run semester:create (admin screens later).';
COMMENT ON COLUMN semesters.applications_open_on IS 'First day students can submit (from 00:00 Budapest time).';
COMMENT ON COLUMN semesters.applications_close_on IS 'Last day students can submit (until 23:59:59 Budapest time).';
COMMENT ON COLUMN semesters.ends_on IS 'Last day of the semester. After it, unreviewed applications are rejected automatically and drafts deleted.';

-- The exact moments, in Budapest time. *_at are exclusive ends: closes_at is the first moment
-- submitting is no longer possible, ends_at the first moment after the semester.
-- last_days_from: the start of the last 7 days of the application period (the warning).
CREATE VIEW semester_bounds AS
SELECT id, name, applications_open_on, applications_close_on, ends_on,
       applications_open_on::timestamp AT TIME ZONE 'Europe/Budapest' AS opens_at,
       (applications_close_on - 6)::timestamp AT TIME ZONE 'Europe/Budapest' AS last_days_from,
       (applications_close_on + 1)::timestamp AT TIME ZONE 'Europe/Budapest' AS closes_at,
       (ends_on + 1)::timestamp AT TIME ZONE 'Europe/Budapest' AS ends_at
FROM semesters;

ALTER TABLE courses ADD COLUMN semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT;
ALTER TABLE applications ADD COLUMN semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT;

COMMENT ON COLUMN courses.semester_id IS 'The semester this course is offered in (courses are imported per semester). NULL = before semesters.';
COMMENT ON COLUMN applications.semester_id IS 'The semester the application was submitted in. NULL = before semesters.';

-- The same course code once per university, programme and semester (each semester's import is new)
ALTER TABLE courses
    DROP CONSTRAINT courses_university_programme_code_key,
    ADD CONSTRAINT courses_university_programme_semester_code_key
        UNIQUE NULLS NOT DISTINCT (university_id, programme_id, semester_id, course_code);

CREATE INDEX courses_semester_id_idx ON courses (semester_id);
CREATE INDEX applications_semester_id_idx ON applications (semester_id);
