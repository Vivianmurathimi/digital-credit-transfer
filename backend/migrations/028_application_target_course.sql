-- 028: each application points to its target PTE course (DB cleanup 1). Runs in one transaction.
--
-- Until now an application only kept a copy of the course it applies for (target_courses: code,
-- name and credits at submission), and "is this course in use?" searched inside that JSON. Now:
--
--   applications.target_course_id   the real course (courses.id). ON DELETE RESTRICT: the database
--                                    refuses to delete a course an application points to.
--   target_courses                  stays: what the student applied for, for history and PDFs,
--                                    even after the course is renamed by a later import.
--   pte_course_names                dropped: an older text copy of the same course
--                                    ("CODE (Name)"); every reader now uses target_courses.
--
-- Filling the pointer, never guessing:
--   1. the course id in the snapshot (target_courses->0->>'course_id'), when that course exists and
--      belongs to the application's programme and semester;
--   2. otherwise the one course of the same programme and semester with the same code, normalised
--      like the server does (no spaces, capitals: utils/applicationForm.js normalizeCourseCode).
-- Any application without exactly one match, with a snapshot id of another programme or semester,
-- or whose snapshot is empty while pte_course_names has text, stops the migration with a list.

ALTER TABLE applications ADD COLUMN target_course_id INTEGER REFERENCES courses(id) ON DELETE RESTRICT;

DO $$
DECLARE
    total integer; by_id integer; by_code integer; problems text;
BEGIN
    SELECT count(*) INTO total FROM applications;

    -- Nothing may be lost when pte_course_names goes: an empty snapshot with legacy text is a problem
    SELECT string_agg(format('#%s (only pte_course_names: %s)', a.id, a.pte_course_names), '; ' ORDER BY a.id) INTO problems
    FROM applications a
    WHERE COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(a.target_courses) = 'array' THEN a.target_courses END), 0) = 0
      AND length(trim(COALESCE(a.pte_course_names, ''))) > 0;
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 028: these applications have no target_courses snapshot, only pte_course_names: %', problems;
    END IF;

    -- A snapshot id that points to a course of another programme or semester: listed, never used
    SELECT string_agg(format('#%s (course %s belongs to programme %s, semester %s; the application to %s, %s)',
                             a.id, c.id, c.programme_id, COALESCE(c.semester_id::text, 'none'), a.programme_id, COALESCE(a.semester_id::text, 'none')), '; ' ORDER BY a.id)
        INTO problems
    FROM applications a JOIN courses c ON c.id::text = a.target_courses->0->>'course_id'
    WHERE c.programme_id <> a.programme_id OR c.semester_id IS DISTINCT FROM a.semester_id;
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 028: the saved course of these applications belongs elsewhere: %', problems;
    END IF;

    -- 1. By the saved id
    UPDATE applications a SET target_course_id = c.id
    FROM courses c
    WHERE c.id::text = a.target_courses->0->>'course_id';
    GET DIAGNOSTICS by_id = ROW_COUNT;

    -- 2. By programme + semester + normalised code, only when exactly one course matches
    WITH candidates AS (
        SELECT a.id AS application_id, min(c.id) AS course_id, count(c.id) AS matches
        FROM applications a
        LEFT JOIN courses c ON c.programme_id = a.programme_id AND c.semester_id IS NOT DISTINCT FROM a.semester_id
             AND upper(regexp_replace(c.course_code, '\s', '', 'g'))
                 = upper(regexp_replace(COALESCE(a.target_courses->0->>'course_code', a.target_course_code, ''), '\s', '', 'g'))
        WHERE a.target_course_id IS NULL
        GROUP BY a.id
    )
    UPDATE applications a SET target_course_id = candidates.course_id
    FROM candidates
    WHERE candidates.application_id = a.id AND candidates.matches = 1;
    GET DIAGNOSTICS by_code = ROW_COUNT;

    -- Whatever is left: stop and list them (none matching, or several)
    SELECT string_agg(format('#%s (programme %s, semester %s, code %s: %s matching course(s))',
                             a.id, a.programme_id, COALESCE(a.semester_id::text, 'none'),
                             COALESCE(a.target_courses->0->>'course_code', a.target_course_code, '?'),
                             (SELECT count(*) FROM courses c WHERE c.programme_id = a.programme_id AND c.semester_id IS NOT DISTINCT FROM a.semester_id
                                  AND upper(regexp_replace(c.course_code, '\s', '', 'g'))
                                      = upper(regexp_replace(COALESCE(a.target_courses->0->>'course_code', a.target_course_code, ''), '\s', '', 'g')))),
                      '; ' ORDER BY a.id)
        INTO problems
    FROM applications a WHERE a.target_course_id IS NULL;
    IF problems IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 028: no single course found for these applications (nothing was changed): %', problems;
    END IF;

    IF by_id + by_code <> total OR (SELECT count(*) FROM applications) <> total THEN
        RAISE EXCEPTION 'Migration 028: % applications, % linked by id and % by code', total, by_id, by_code;
    END IF;
    RAISE NOTICE 'Migration 028: % application(s) linked to their course: % by the saved id, % by programme, semester and code.', total, by_id, by_code;
END $$;

ALTER TABLE applications ALTER COLUMN target_course_id SET NOT NULL;
CREATE INDEX applications_target_course_id_idx ON applications (target_course_id);
COMMENT ON COLUMN applications.target_course_id IS 'The PTE course applied for (courses.id). The database refuses to delete a course an application points to. target_courses keeps what the course was called at submission.';

ALTER TABLE applications DROP COLUMN pte_course_names;
