-- 020: the timeline (round 2, Group 1 Part D). Runs in one transaction.
--
-- A semester now has three moments that matter, and two labels:
--   applications_open_at / applications_close_at  the application period (Close now and Reopen
--                                                  until change the close, as before)
--   review_end_at                                 the review deadline: a TARGET for reviewers,
--                                                  never a lock. Reviewing is allowed from the first
--                                                  application on; at the deadline nothing is
--                                                  rejected, the admins are told once.
--   name, end_date                                labels for records, imports and searching only;
--                                                  end_date no longer allows or blocks anything.
--
-- Several semesters can be in progress at once (status 'active'): the next one's application
-- period may open while the previous one is still being reviewed. Application PERIODS never
-- overlap (a database rule), so a new application always belongs to exactly one semester.
--
-- Existing semesters get review_end_at = applications_close_at + 14 days (Budapest wall clock, so
-- 23:59 stays 23:59 across a clock change). Nothing is deleted; the old rules are replaced:
--   semesters_one_active        (one active semester)            dropped
--   semesters_no_overlap        (whole semesters never overlap)  -> application periods never overlap
--   semesters_times_in_order    (open < close, close day <= end) -> open < close <= review deadline
-- review_deadline_alerts: the admins' "review deadline passed with undecided applications" email,
-- once per semester, recorded before it is sent (like the other reminders).

ALTER TABLE semesters ADD COLUMN review_end_at TIMESTAMPTZ;

UPDATE semesters
SET review_end_at = ((applications_close_at AT TIME ZONE 'Europe/Budapest') + interval '14 days') AT TIME ZONE 'Europe/Budapest';

DO $$
DECLARE
    total integer; filled integer;
BEGIN
    SELECT count(*), count(review_end_at) INTO total, filled FROM semesters;
    IF filled <> total THEN
        RAISE EXCEPTION 'Migration 020: % semester(s), but % got a review deadline', total, filled;
    END IF;
    RAISE NOTICE 'Migration 020: % semester(s) got a review deadline (applications close + 14 days).', filled;
END $$;

ALTER TABLE semesters ALTER COLUMN review_end_at SET NOT NULL;

COMMENT ON COLUMN semesters.review_end_at IS 'The review deadline: a target, not a lock. Default applications_close_at + 14 days; the admin moves it. When it passes with applications still pending or in needs info, nothing is rejected: the admins get one email (review_deadline_alerts).';
COMMENT ON COLUMN semesters.end_date IS 'A label (the semester''s last day) for records, imports and searching. It does not allow or block anything.';

-- The rules
DROP INDEX semesters_one_active;
ALTER TABLE semesters
    DROP CONSTRAINT semesters_no_overlap,
    DROP CONSTRAINT semesters_times_in_order,
    ADD CONSTRAINT semesters_times_in_order CHECK (applications_open_at < applications_close_at AND applications_close_at <= review_end_at),
    -- Application periods never overlap, whatever the semesters' status: a new application belongs to one semester
    ADD CONSTRAINT semesters_periods_no_overlap EXCLUDE USING gist (
        tstzrange(applications_open_at, applications_close_at, '[)') WITH &&);

-- The moments, with the names used so far (ends_on / ends_at stay, as labels)
DROP VIEW semester_bounds;
CREATE VIEW semester_bounds AS
SELECT id, name, status,
       applications_open_at AS opens_at,
       applications_close_at AS closes_at,
       applications_close_at - make_interval(days => last_days_warning_days) AS last_days_from,
       review_end_at AS review_ends_at,
       end_date AS ends_on,
       (end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' AS ends_at,
       close_reason,
       last_days_warning_days
FROM semesters;

-- The admins' email when the review deadline passes with undecided applications: once per semester
CREATE TABLE review_deadline_alerts (
    semester_id INTEGER PRIMARY KEY REFERENCES semesters(id) ON DELETE CASCADE,
    pending_count INTEGER NOT NULL CHECK (pending_count >= 0),
    needs_info_count INTEGER NOT NULL CHECK (needs_info_count >= 0),
    sent_at TIMESTAMPTZ NOT NULL
);
COMMENT ON TABLE review_deadline_alerts IS 'One "the review deadline passed, these applications are still undecided" email to the admins per semester, recorded before it is sent (never twice, also with two processes).';

-- The reviewers' reminders now count down to the review deadline (7 days and 1 day before)
COMMENT ON TABLE reviewer_reminders IS 'Reminders to reviewers before a semester''s REVIEW DEADLINE (7_days, 1_day), one per semester, programme and kind, recorded before the email is sent.';
