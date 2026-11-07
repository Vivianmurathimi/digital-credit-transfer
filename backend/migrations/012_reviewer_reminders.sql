-- 012: reminders to reviewers before the semester ends (reviewer Group 7).
--
-- When a programme's active reviewer still has undecided applications (pending or waiting for the
-- student's reply) in a semester that is about to end, the background job emails them twice:
--   7_days: from 00:00 Budapest time 7 days before the semester's end (6 days before its last day)
--   1_day:  on the semester's last day, from 00:00 Budapest time
-- One row per semester, programme and kind. The row is written BEFORE the email is sent, and the
-- unique key makes the insert succeed only once, so a reminder is never sent twice (also with two
-- backend processes, or after a restart).

CREATE TABLE reviewer_reminders (
    id SERIAL PRIMARY KEY,
    semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
    programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('7_days', '1_day')),
    reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    pending_count INTEGER NOT NULL CHECK (pending_count >= 0),
    needs_info_count INTEGER NOT NULL CHECK (needs_info_count >= 0),
    sent_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT reviewer_reminders_once UNIQUE (semester_id, programme_id, kind)
);

CREATE INDEX reviewer_reminders_programme_id_idx ON reviewer_reminders (programme_id);
CREATE INDEX reviewer_reminders_reviewer_id_idx ON reviewer_reminders (reviewer_id);

COMMENT ON TABLE reviewer_reminders IS 'Reviewer reminders sent before a semester ends (one per semester, programme and kind). Written by the background job only.';
COMMENT ON COLUMN reviewer_reminders.kind IS '7_days (a week before the end) or 1_day (on the last day).';
COMMENT ON COLUMN reviewer_reminders.pending_count IS 'Applications waiting for the reviewer''s decision when the reminder was sent.';
COMMENT ON COLUMN reviewer_reminders.needs_info_count IS 'Applications waiting for the student''s reply when the reminder was sent.';
COMMENT ON COLUMN reviewer_reminders.sent_at IS 'When the reminder was recorded, just before its email was sent.';

-- From now on automatic rejections store only their reason code (application_events.reason_code),
-- never English text: every screen, email and the term book translate the code. Older rows keep
-- their text (the history is append-only).
COMMENT ON COLUMN applications.decision_rationale IS 'The reason given with the approval or rejection, shown to the student. Empty for automatic rejections (decided_by_role = system): their reason is the reason_code of the auto_rejected event, translated where it is shown.';
