-- 031: reviewers and committee members can turn off their daily summary email (professor's review
-- notes). Runs in one transaction.
--
--   users.reviewer_summary_email    the reviewers' daily summary at 07:00 (reviewer_summaries)
--   users.committee_summary_email   the committee members' daily summary at 07:00 (committee_summaries)
--
-- Only these two emails can be switched off. Deadline reminders, the admins' alerts, invites,
-- account emails and every student email are always sent. Default on, also for existing accounts.
-- A switched-off day is still recorded and its window still moves on (jobs/applicationJobs.js), so
-- turning the email back on never sends a backlog. Each person changes only their own switches
-- (GET/PUT /api/me/email-settings), never while the admin acts as them.

CREATE TEMP TABLE m031_counts ON COMMIT DROP AS SELECT count(*) AS users FROM users;

ALTER TABLE users
    ADD COLUMN reviewer_summary_email BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN committee_summary_email BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN users.reviewer_summary_email IS 'The reviewer''s daily summary email (07:00). Off: the day is still recorded (reviewer_summaries, emailed = false) and its window moves on, so nothing piles up. Deadline reminders are always sent.';
COMMENT ON COLUMN users.committee_summary_email IS 'The committee member''s daily summary email (07:00). Off: the day is still recorded (committee_summaries, emailed = false) and its window moves on. Deadline reminders are always sent.';

DO $$
DECLARE
    before integer; after integer; off integer;
BEGIN
    SELECT users INTO before FROM m031_counts;
    SELECT count(*), count(*) FILTER (WHERE NOT reviewer_summary_email OR NOT committee_summary_email) INTO after, off FROM users;
    IF after <> before OR off <> 0 THEN
        RAISE EXCEPTION 'Migration 031: % users before, % after, % with a switch off', before, after, off;
    END IF;
    RAISE NOTICE 'Migration 031: % user(s); both daily summary emails on for everyone.', after;
END $$;
