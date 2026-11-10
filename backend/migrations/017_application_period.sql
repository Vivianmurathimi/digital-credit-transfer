-- 017: the application period (admin round, Group 5). Runs in one transaction.
--
-- One rule decides who may register and submit (utils/applicationPeriod.js): the active
-- semester's opening and closing times, Close now and Reopen until (which change exactly those
-- times), and late access. The old admin toggle (system_settings.is_submissions_open) goes:
--   false -> "Close now" on the active semester, if its period is running at this moment
--   true  -> nothing: the dates are in charge
-- Back up the database first (README: "Before a migration").

-- ---------- semesters: last-days warning and the Close now reason ----------
ALTER TABLE semesters
    ADD COLUMN last_days_warning_days INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN close_reason VARCHAR(300),
    ADD CONSTRAINT semesters_last_days_range CHECK (last_days_warning_days BETWEEN 0 AND 60);

COMMENT ON COLUMN semesters.last_days_warning_days IS 'How many days before closing the form warns "Applications close on <date>" (set by the admin, default 3).';
COMMENT ON COLUMN semesters.close_reason IS 'NULL: the period closes by its dates. Set by Close now: the reason shown to students, or empty when none was given. Cleared by Reopen until and by editing the times.';

-- The view gets the admin's number of warning days (it was a fixed 7 days)
DROP VIEW semester_bounds;
CREATE VIEW semester_bounds AS
SELECT id, name, status,
       applications_open_at AS opens_at,
       applications_close_at AS closes_at,
       applications_close_at - make_interval(days => last_days_warning_days) AS last_days_from,
       end_date AS ends_on,
       (end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' AS ends_at,
       close_reason,
       last_days_warning_days
FROM semesters;

-- ---------- late access ----------
CREATE TABLE late_access (
    id SERIAL PRIMARY KEY,
    email VARCHAR(100) NOT NULL CHECK (email = lower(email)),
    semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
    deadline TIMESTAMPTZ NOT NULL,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT late_access_revoked_after_grant CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
-- One valid grant per address and semester (granting again replaces it)
CREATE UNIQUE INDEX late_access_one_per_email ON late_access (semester_id, email) WHERE revoked_at IS NULL;

COMMENT ON TABLE late_access IS 'Students (by email, also before they register) who may register and submit until their own deadline while the application period is closed. Revoking takes effect at once.';

-- ---------- the old toggle ----------
DO $$
DECLARE
    toggle_open boolean;
    closed integer := 0;
BEGIN
    IF to_regclass('public.system_settings') IS NULL THEN
        RETURN;
    END IF;
    SELECT is_submissions_open INTO toggle_open FROM system_settings ORDER BY id LIMIT 1;
    IF toggle_open IS FALSE THEN
        UPDATE semesters SET applications_close_at = now(), close_reason = ''
        WHERE status = 'active' AND applications_open_at < now() AND applications_close_at > now();
        GET DIAGNOSTICS closed = ROW_COUNT;
    END IF;
    RAISE NOTICE 'Migration 017: the old toggle was %; % semester(s) closed now.', coalesce(toggle_open::text, 'not set'), closed;
END $$;

DROP TABLE IF EXISTS system_settings;
