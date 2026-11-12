-- 021: emails to reviewers (round 2, Group 1 Part E). Runs in one transaction.
--
-- Reviewers no longer get an email per new application and per student reply. Instead, ONE
-- daily summary per reviewer at 07:00 Budapest time, only when something new happened since
-- their last summary in what they can see (utils/reviewers.js: main reviewer, or extra reviewer
-- while allowed to assist).
--
-- reviewer_summaries: one row per reviewer and Budapest day, written by the first job run at or
-- after 07:00 that day (also when nothing was new, so a later run that day never sends one).
-- The insert succeeds only once (primary key), so a summary is never sent twice: not after a
-- restart, not with two processes. covered_until is where the next summary starts, so nothing is
-- told twice and nothing is missed, also when the server was off for days.
--
-- reviewer_reminders (the reminders before the review deadline) go to everyone who can see the
-- programme's undecided applications, so the "once" key now includes the reviewer. The existing
-- rows keep their meaning (one per semester, programme and kind, to that reviewer).

CREATE TABLE reviewer_summaries (
    reviewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day DATE NOT NULL,                      -- the Budapest day of the summary
    covered_from TIMESTAMPTZ NOT NULL,      -- events after this moment ...
    covered_until TIMESTAMPTZ NOT NULL,     -- ... up to this one are in it
    new_applications INTEGER NOT NULL DEFAULT 0 CHECK (new_applications >= 0),
    student_replies INTEGER NOT NULL DEFAULT 0 CHECK (student_replies >= 0),
    emailed BOOLEAN NOT NULL DEFAULT false, -- false: nothing new, no email
    PRIMARY KEY (reviewer_id, day),
    CONSTRAINT reviewer_summaries_window CHECK (covered_from <= covered_until)
);
COMMENT ON TABLE reviewer_summaries IS 'The reviewers'' daily summary (07:00 Budapest time): one row per reviewer and day, recorded before the email is sent, also when nothing was new (then no email). covered_until is where the next one starts.';

DO $$
DECLARE
    before_count integer; after_count integer;
BEGIN
    SELECT count(*) INTO before_count FROM reviewer_reminders;
    ALTER TABLE reviewer_reminders DROP CONSTRAINT reviewer_reminders_once;
    ALTER TABLE reviewer_reminders ADD CONSTRAINT reviewer_reminders_once UNIQUE (semester_id, programme_id, kind, reviewer_id);
    SELECT count(*) INTO after_count FROM reviewer_reminders;
    IF after_count <> before_count THEN
        RAISE EXCEPTION 'Migration 021: % reminder row(s) before, % after', before_count, after_count;
    END IF;
    RAISE NOTICE 'Migration 021: % reminder row(s) kept; reminders are now once per semester, programme, kind and reviewer.', after_count;
END $$;

COMMENT ON TABLE reviewer_reminders IS 'Reminders before a semester''s REVIEW DEADLINE (7_days, 1_day) to everyone who can see the programme''s undecided applications: one per semester, programme, kind and reviewer, recorded before the email is sent.';
