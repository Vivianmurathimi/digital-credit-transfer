-- 016: semesters with a status and exact times, and a catalogue with active / hidden items
-- (admin round, Group 4). Runs in one transaction (utils/migrations.js): if any check below
-- fails, nothing at all is changed. Back up the database first (README: "Before a migration").
--
-- 1. semesters: the three DAY columns become exact moments, stored in UTC:
--      applications_open_on  -> applications_open_at  = 00:00 that day, Budapest time
--      applications_close_on -> applications_close_at = 23:59 that day, Budapest time
--                                (so nothing closes a day early)
--      ends_on               -> end_date (still a Budapest day: the semester's last day)
--    plus status (setup | active | closed), closed_at and closed_by. Only one semester can be
--    active (unique index). Existing semesters get their status from today's date: ended ->
--    closed (closed_at = its end, closed_by empty), running -> active, coming -> setup.
--    The day columns are dropped only after checking that every row was converted.
-- 2. Applications and courses without a semester join the ACTIVE semester. If there is none, a
--    "Starting semester" is created as active and they go there. Nothing is ever put into a
--    closed semester, so this migration causes no rejection and no email: pending applications
--    stay pending.
-- 3. programmes and courses get status (active | hidden); everything existing is active.
-- The semester_bounds view keeps its column names, so every query using it works unchanged.

-- ---------- 1. semesters: day columns -> moments ----------
ALTER TABLE semesters
    ADD COLUMN status VARCHAR(10),
    ADD COLUMN applications_open_at TIMESTAMPTZ,
    ADD COLUMN applications_close_at TIMESTAMPTZ,
    ADD COLUMN end_date DATE,
    ADD COLUMN closed_at TIMESTAMPTZ,
    ADD COLUMN closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

UPDATE semesters SET
    applications_open_at  = applications_open_on::timestamp AT TIME ZONE 'Europe/Budapest',
    applications_close_at = (applications_close_on::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
    end_date              = ends_on;

UPDATE semesters SET
    status = CASE
        WHEN (end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' <= now() THEN 'closed'
        WHEN applications_open_at <= now() THEN 'active'
        ELSE 'setup' END,
    closed_at = CASE WHEN (end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' <= now()
                     THEN (end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' END;

-- Every row converted? Only then are the day columns dropped.
DO $$
DECLARE
    total integer;
    converted integer;
    active integer;
BEGIN
    SELECT count(*) INTO total FROM semesters;
    SELECT count(*) INTO converted FROM semesters
    WHERE status IS NOT NULL AND applications_open_at IS NOT NULL AND applications_close_at IS NOT NULL AND end_date IS NOT NULL
      AND (applications_open_at AT TIME ZONE 'Europe/Budapest')::date = applications_open_on
      AND (applications_close_at AT TIME ZONE 'Europe/Budapest')::date = applications_close_on
      AND end_date = ends_on;
    IF converted <> total THEN
        RAISE EXCEPTION 'Migration 016: % of % semesters converted; nothing was changed.', converted, total;
    END IF;
    SELECT count(*) INTO active FROM semesters WHERE status = 'active';
    IF active > 1 THEN
        RAISE EXCEPTION 'Migration 016: % semesters would be active at once; nothing was changed.', active;
    END IF;
END $$;

DROP VIEW semester_bounds;
ALTER TABLE semesters
    DROP CONSTRAINT semesters_dates_in_order,
    DROP CONSTRAINT semesters_no_overlap,
    DROP COLUMN applications_open_on,
    DROP COLUMN applications_close_on,
    DROP COLUMN ends_on;

ALTER TABLE semesters
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN status SET DEFAULT 'setup',
    ALTER COLUMN applications_open_at SET NOT NULL,
    ALTER COLUMN applications_close_at SET NOT NULL,
    ALTER COLUMN end_date SET NOT NULL,
    ADD CONSTRAINT semesters_status_known CHECK (status IN ('setup', 'active', 'closed')),
    ADD CONSTRAINT semesters_times_in_order CHECK (
        applications_open_at < applications_close_at
        AND (applications_close_at AT TIME ZONE 'Europe/Budapest')::date <= end_date),
    ADD CONSTRAINT semesters_closed_has_time CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
    -- From the opening day to the last semester day: never two semesters at once
    ADD CONSTRAINT semesters_no_overlap EXCLUDE USING gist (
        daterange((applications_open_at AT TIME ZONE 'Europe/Budapest')::date, end_date, '[]') WITH &&);

-- Only one active semester (the next one can wait in setup)
CREATE UNIQUE INDEX semesters_one_active ON semesters ((true)) WHERE status = 'active';

COMMENT ON COLUMN semesters.status IS 'setup: being prepared; active: the current semester (one at most, the admin activates it); closed: over, read-only.';
COMMENT ON COLUMN semesters.applications_open_at IS 'When students can start submitting (stored in UTC; shown in Budapest time).';
COMMENT ON COLUMN semesters.applications_close_at IS 'When submitting ends (stored in UTC; shown in Budapest time).';
COMMENT ON COLUMN semesters.end_date IS 'The semester''s last day (Budapest). After it, unreviewed applications are rejected automatically.';
COMMENT ON COLUMN semesters.closed_by IS 'The admin who closed it; empty for semesters closed by the date (before the admin round).';

-- The exact moments, with the same column names as before (migration 008).
-- *_at are exclusive ends: closes_at is the first moment submitting is no longer possible,
-- ends_at the first moment after the semester. ends_on: the last day (Budapest).
CREATE VIEW semester_bounds AS
SELECT id, name, status,
       applications_open_at AS opens_at,
       applications_close_at AS closes_at,
       applications_close_at - interval '7 days' AS last_days_from,
       end_date AS ends_on,
       (end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' AS ends_at
FROM semesters;

-- ---------- 2. applications and courses without a semester ----------
DO $$
DECLARE
    target integer;
    today date := (now() AT TIME ZONE 'Europe/Budapest')::date;
    earliest date;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM applications WHERE semester_id IS NULL)
       AND NOT EXISTS (SELECT 1 FROM courses WHERE semester_id IS NULL) THEN
        RETURN;
    END IF;

    SELECT id INTO target FROM semesters WHERE status = 'active';
    IF target IS NULL THEN
        -- Open from the oldest such application (or today) until 30 days from now, ending in 90 days
        SELECT least(min((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Budapest')::date, today)
        INTO earliest FROM applications WHERE semester_id IS NULL;
        INSERT INTO semesters (name, status, applications_open_at, applications_close_at, end_date)
        VALUES ('Starting semester', 'active',
                coalesce(earliest, today)::timestamp AT TIME ZONE 'Europe/Budapest',
                ((today + 30)::timestamp + time '23:59') AT TIME ZONE 'Europe/Budapest',
                today + 90)
        RETURNING id INTO target;
    END IF;

    UPDATE applications SET semester_id = target WHERE semester_id IS NULL;
    UPDATE courses SET semester_id = target WHERE semester_id IS NULL;
END $$;

-- ---------- 3. catalogue status ----------
ALTER TABLE programmes
    ADD COLUMN status VARCHAR(10) NOT NULL DEFAULT 'active',
    ADD CONSTRAINT programmes_status_known CHECK (status IN ('active', 'hidden'));
ALTER TABLE courses
    ADD COLUMN status VARCHAR(10) NOT NULL DEFAULT 'active',
    ADD CONSTRAINT courses_status_known CHECK (status IN ('active', 'hidden'));

COMMENT ON COLUMN programmes.status IS 'active, or hidden: not offered at registration or for new applications; its students keep their existing ones.';
COMMENT ON COLUMN courses.status IS 'active, or hidden: cannot be picked any more; existing applications show it as "no longer offered".';
