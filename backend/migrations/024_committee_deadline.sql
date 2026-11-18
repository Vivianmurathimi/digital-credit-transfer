-- 024: the committee deadline (round 2, Group 2 Part F). Runs in one transaction.
--
-- After the review deadline, the committee has its own target: the COMMITTEE DEADLINE. Like the
-- review deadline it is never a lock: nothing is decided or rejected when it passes; the admins
-- are told once, and the members are reminded before it.
--
--   semesters.committee_end_at   NULL = the default: the review deadline + 14 days (Budapest wall
--                                clock, so 23:59 stays 23:59 across a clock change); a moment = the
--                                admin chose it. Never before the review deadline (a rule). When the
--                                review deadline moves past a chosen committee deadline (Reopen
--                                until, late access, an edit), the chosen one is dropped and the
--                                default applies again (a trigger), so those steps never fail on it.
--   semester_bounds.committee_ends_at   the deadline in effect (chosen, or the default). The 14 days
--                                are utils/semesters.js COMMITTEE_DAYS_DEFAULT; a test checks both agree.
--
-- Recorded before any email is sent, so each goes out once, also with two processes:
--   committee_deadline_alerts   the admins' "committee deadline passed, still awaiting" email, once per semester
--   committee_reminders         7 days and 1 day before it, to each committee member of a programme
--                               with applications awaiting: once per semester, programme, kind, member
--   committee_summaries         the members' daily summary (07:00 Budapest), once per member and day;
--                               separate from reviewer_summaries, so someone with both kinds of link
--                               gets two emails, each recorded once per person, kind and day
-- Existing semesters keep the default (NULL): nothing to copy, nothing deleted.

ALTER TABLE semesters ADD COLUMN committee_end_at TIMESTAMPTZ;
ALTER TABLE semesters ADD CONSTRAINT semesters_committee_after_review
    CHECK (committee_end_at IS NULL OR committee_end_at >= review_end_at);
COMMENT ON COLUMN semesters.committee_end_at IS 'The committee deadline chosen by the admin; NULL = the default, the review deadline + 14 days (semester_bounds.committee_ends_at). A target, not a lock: when it passes with applications awaiting the committee, the admins get one email (committee_deadline_alerts).';

-- A review deadline moved past a chosen committee deadline: back to the default
CREATE FUNCTION semesters_committee_follows_review() RETURNS trigger AS $$
BEGIN
    IF NEW.committee_end_at IS NOT NULL AND NEW.committee_end_at < NEW.review_end_at THEN
        NEW.committee_end_at := NULL;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER semesters_committee_follows_review
    BEFORE UPDATE OF review_end_at ON semesters
    FOR EACH ROW WHEN (NEW.review_end_at IS DISTINCT FROM OLD.review_end_at)
    EXECUTE FUNCTION semesters_committee_follows_review();

-- The moments, as before, with the committee deadline in effect added at the end
CREATE OR REPLACE VIEW semester_bounds AS
SELECT id, name, status,
       applications_open_at AS opens_at,
       applications_close_at AS closes_at,
       applications_close_at - make_interval(days => last_days_warning_days) AS last_days_from,
       review_end_at AS review_ends_at,
       end_date AS ends_on,
       (end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' AS ends_at,
       close_reason,
       last_days_warning_days,
       COALESCE(committee_end_at,
                ((review_end_at AT TIME ZONE 'Europe/Budapest') + interval '14 days') AT TIME ZONE 'Europe/Budapest') AS committee_ends_at
FROM semesters;

CREATE TABLE committee_deadline_alerts (
    semester_id INTEGER PRIMARY KEY REFERENCES semesters(id) ON DELETE CASCADE,
    awaiting_count INTEGER NOT NULL CHECK (awaiting_count >= 0),
    sent_at TIMESTAMPTZ NOT NULL
);
COMMENT ON TABLE committee_deadline_alerts IS 'One "the committee deadline passed, these applications still await the committee" email to the admins per semester, recorded before it is sent.';

CREATE TABLE committee_reminders (
    id SERIAL PRIMARY KEY,
    semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
    programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('7_days', '1_day')),
    member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    awaiting_count INTEGER NOT NULL CHECK (awaiting_count >= 0),
    sent_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT committee_reminders_once UNIQUE (semester_id, programme_id, kind, member_id)
);
CREATE INDEX committee_reminders_programme_id_idx ON committee_reminders (programme_id);
CREATE INDEX committee_reminders_member_id_idx ON committee_reminders (member_id);
COMMENT ON TABLE committee_reminders IS 'Reminders before a semester''s COMMITTEE DEADLINE (7_days, 1_day) to every current committee member of a programme with applications awaiting the committee: one per semester, programme, kind and member, recorded before the email is sent.';

CREATE TABLE committee_summaries (
    member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day DATE NOT NULL,                      -- the Budapest day of the summary
    covered_from TIMESTAMPTZ NOT NULL,      -- decisions after this moment ...
    covered_until TIMESTAMPTZ NOT NULL,     -- ... up to this one are in it
    new_decisions INTEGER NOT NULL DEFAULT 0 CHECK (new_decisions >= 0),
    emailed BOOLEAN NOT NULL DEFAULT false, -- false: nothing new, no email
    PRIMARY KEY (member_id, day),
    CONSTRAINT committee_summaries_window CHECK (covered_from <= covered_until)
);
COMMENT ON TABLE committee_summaries IS 'The committee members'' daily summary (07:00 Budapest time): one row per member and day, recorded before the email is sent, also when nothing was new (then no email). covered_until is where the next one starts.';

DO $$
DECLARE
    total integer; defaulted integer; in_view integer;
BEGIN
    SELECT count(*), count(*) FILTER (WHERE committee_end_at IS NULL) INTO total, defaulted FROM semesters;
    SELECT count(*) INTO in_view FROM semester_bounds WHERE committee_ends_at >= review_ends_at;
    IF defaulted <> total OR in_view <> total THEN
        RAISE EXCEPTION 'Migration 024: % semester(s), % on the default, % with a committee deadline after the review deadline', total, defaulted, in_view;
    END IF;
    RAISE NOTICE 'Migration 024: % semester(s) got the default committee deadline (review deadline + 14 days).', total;
END $$;
