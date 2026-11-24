-- 030: remove the old universities table and courses.university_id (DB cleanup 3). One transaction.
--
-- Every course in this catalogue is a PTE course: the university was never chosen anywhere, the
-- import only copied whatever it found, and the table is empty in practice. So:
--   - the unique rule becomes one course code per programme and semester
--     (courses_programme_semester_code_key; NULLS NOT DISTINCT, as before, for courses without a semester)
--   - courses.university_id and the universities table are dropped
-- The students' previous institutions (applications.institutions: name, country, grading file) are
-- a different thing and stay as they are.
-- Before anything changes: no two courses may share programme + semester + normalised code (no
-- spaces, capitals, as the server does), and nothing but courses.university_id may point to
-- universities. Otherwise the migration stops with a list.

DO $$
DECLARE
    duplicates text; others text;
BEGIN
    SELECT string_agg(format('programme %s, semester %s, code %s: courses %s', programme_id, COALESCE(semester_id::text, 'none'), code, ids), '; ')
        INTO duplicates
    FROM (
        SELECT programme_id, semester_id, upper(regexp_replace(course_code, '\s', '', 'g')) AS code, string_agg(id::text, ', ' ORDER BY id) AS ids
        FROM courses GROUP BY 1, 2, 3 HAVING count(*) > 1
    ) d;
    IF duplicates IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 030: these courses share programme, semester and code (nothing was changed): %', duplicates;
    END IF;

    SELECT string_agg(format('%s (%s)', conrelid::regclass, conname), ', ') INTO others
    FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'universities'::regclass AND conname <> 'courses_university_id_fkey';
    IF others IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 030: something else points to universities (nothing was changed): %', others;
    END IF;
END $$;

CREATE TEMP TABLE m030_counts ON COMMIT DROP AS
SELECT (SELECT count(*) FROM courses) AS courses, (SELECT count(*) FROM universities) AS universities,
       (SELECT count(*) FROM courses WHERE university_id IS NOT NULL) AS with_university;

ALTER TABLE courses DROP CONSTRAINT courses_university_programme_semester_code_key;
ALTER TABLE courses ADD CONSTRAINT courses_programme_semester_code_key UNIQUE NULLS NOT DISTINCT (programme_id, semester_id, course_code);
ALTER TABLE courses DROP COLUMN university_id;
DROP TABLE universities;

DO $$
DECLARE
    before record;
BEGIN
    SELECT * INTO before FROM m030_counts;
    IF (SELECT count(*) FROM courses) <> before.courses THEN
        RAISE EXCEPTION 'Migration 030: % courses before, % after', before.courses, (SELECT count(*) FROM courses);
    END IF;
    IF to_regclass('public.universities') IS NOT NULL
       OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'university_id') THEN
        RAISE EXCEPTION 'Migration 030: universities or courses.university_id is still there';
    END IF;
    RAISE NOTICE 'Migration 030: % course(s) unchanged (% had a university); the universities table (% row(s)) and courses.university_id are gone; one course code per programme and semester.',
        before.courses, before.with_university, before.universities;
END $$;
