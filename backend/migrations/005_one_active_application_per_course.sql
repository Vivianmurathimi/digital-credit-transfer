-- 005: one active application per student and PTE course (Group 6).
-- A new application is refused while the student has one for the same PTE course that is
-- pending, waiting for more information (needs_info) or approved. Any other status (rejected,
-- and a future "withdrawn") allows a new one.
--
-- The course is identified by its normalised code (upper case, no spaces) and the programme,
-- not by the course id: courses are re-imported each semester with new ids. Group 3 can use
-- the same column to look up earlier semesters.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM applications
        WHERE status IN ('pending', 'needs_info', 'approved') AND target_courses IS NOT NULL
        GROUP BY student_id, programme_id, upper(regexp_replace(target_courses->0->>'course_code', '\s', '', 'g'))
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'Migration 005 found students with more than one active application for the same PTE course. In development, run "npm run reset:dev -- --yes", then "npm run migrate" and "npm run seed:dev".';
    END IF;
END $$;

ALTER TABLE applications ADD COLUMN target_course_code VARCHAR(50);

UPDATE applications
SET target_course_code = upper(regexp_replace(target_courses->0->>'course_code', '\s', '', 'g'))
WHERE target_courses IS NOT NULL;

COMMENT ON COLUMN applications.target_course_code IS
    'Normalised code (upper case, no spaces) of the target PTE course, written by the server from target_courses. Used for the one-active-application rule and (Group 3) earlier semesters.';

-- The rule itself, enforced by the database: two submits at the same moment can't both pass
CREATE UNIQUE INDEX applications_one_active_per_course
    ON applications (student_id, programme_id, target_course_code)
    WHERE status IN ('pending', 'needs_info', 'approved');
