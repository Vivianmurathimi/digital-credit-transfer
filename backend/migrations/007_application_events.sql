-- 007: the history of each application, and the "needs info" reply deadline (Groups 8 and 9).
--
-- Until now each note was a single column that the next step overwrote (the reviewer's note on every
-- status change, the student's reply on every resubmit), so earlier rounds were lost.
-- application_events keeps every step instead, in order. The old columns are still written,
-- so the reviewer screen, admin screen and term book keep working unchanged.

CREATE TABLE application_events (
    id BIGSERIAL PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    kind VARCHAR(20) NOT NULL
        CHECK (kind IN ('submitted', 'info_requested', 'replied', 'decided', 'withdrawn', 'auto_rejected')),
    actor_role VARCHAR(20) NOT NULL CHECK (actor_role IN ('student', 'reviewer', 'admin', 'system')),
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(50) NOT NULL,
    note TEXT,
    reason_code VARCHAR(50),
    files TEXT[] NOT NULL DEFAULT '{}',
    backfilled BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX application_events_by_application ON application_events (application_id, created_at, id);

COMMENT ON TABLE application_events IS
    'Append-only history of each application. Rows are never changed or deleted (a trigger refuses it), except together with their application.';
COMMENT ON COLUMN application_events.kind IS
    'submitted, info_requested (reviewer/admin asked for more information), replied (student resubmitted), decided (approved, rejected or back to pending), withdrawn (by the student), auto_rejected (no reply by the deadline)';
COMMENT ON COLUMN application_events.actor_role IS
    'Who did it, as the student is told: student, reviewer, admin or system. actor_id (internal, never sent to students) is the user, or NULL for system.';
COMMENT ON COLUMN application_events.status IS 'The application''s status after this step.';
COMMENT ON COLUMN application_events.reason_code IS 'A translatable reason, e.g. NO_INFO_RESPONSE for an automatic rejection.';
COMMENT ON COLUMN application_events.files IS 'Files the student added with a reply.';
COMMENT ON COLUMN application_events.backfilled IS
    'Rebuilt by this migration from the old single columns: only the latest note of each kind was still known, and the time is the closest one recorded.';

-- Append-only: an event can be added, never edited. It can only be deleted together with its
-- application (ON DELETE CASCADE, e.g. npm run reset:dev), never on its own.
CREATE FUNCTION application_events_append_only() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM applications WHERE id = OLD.application_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'application_events is append-only: events cannot be changed or deleted'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_events_append_only
    BEFORE UPDATE OR DELETE ON application_events
    FOR EACH ROW EXECUTE FUNCTION application_events_append_only();

-- The "needs info" reply deadline: the end of the third calendar day after the request,
-- 23:59:59 in Budapest, weekends included. Worked out with the database's time-zone rules,
-- so a deadline across a clock change is still 23:59:59 local time (never a fixed +1/+2 hours).
-- Example: requested on 30 October at any time -> 2 November 23:59:59 Budapest time.
CREATE FUNCTION info_reply_deadline(requested_at TIMESTAMPTZ) RETURNS TIMESTAMPTZ AS $$
    SELECT (date_trunc('day', requested_at AT TIME ZONE 'Europe/Budapest')
            + INTERVAL '3 days' + INTERVAL '23 hours 59 minutes 59 seconds') AT TIME ZONE 'Europe/Budapest';
$$ LANGUAGE sql STABLE;

ALTER TABLE applications
    ADD COLUMN info_requested_at TIMESTAMPTZ,
    ADD COLUMN info_deadline TIMESTAMPTZ,
    ADD COLUMN info_reminder_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN applications.info_requested_at IS 'When the application was last sent back for more information (set while status = needs_info, NULL otherwise).';
COMMENT ON COLUMN applications.info_deadline IS 'Reply deadline (info_reply_deadline). No reply by then: rejected automatically by the background job.';
COMMENT ON COLUMN applications.info_reminder_sent_at IS 'When the one reminder email before the deadline was sent (NULL = not yet).';

-- Applications already waiting for information get a fresh, full deadline from today,
-- so nobody is rejected the moment the job first runs
UPDATE applications
SET info_requested_at = now(), info_deadline = info_reply_deadline(now())
WHERE status = 'needs_info';

-- History for existing applications, rebuilt from the old columns (created_at and reviewed_at
-- are stored as UTC without a time zone). Only the latest note of each kind is still known.
INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note, backfilled, created_at)
SELECT id, 'submitted', 'student', student_id, 'pending', student_note, true, created_at AT TIME ZONE 'UTC'
FROM applications
ORDER BY id;

-- A reply exists: the request for information came before it
INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note, backfilled, created_at)
SELECT a.id, 'info_requested', CASE WHEN r.role = 'superadmin' THEN 'admin' ELSE 'reviewer' END, a.reviewed_by,
       'needs_info', a.reviewer_note, true, COALESCE(a.reviewed_at, a.created_at) AT TIME ZONE 'UTC'
FROM applications a LEFT JOIN users r ON r.id = a.reviewed_by
WHERE a.status = 'pending' AND (a.student_resubmit_note IS NOT NULL OR COALESCE(a.supplemental_files, '') <> '')
ORDER BY a.id;

INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note, files, backfilled, created_at)
SELECT id, 'replied', 'student', student_id, 'pending', student_resubmit_note,
       COALESCE(array_remove(string_to_array(replace(supplemental_files, ' ', ''), ','), ''), '{}'),
       true, COALESCE(reviewed_at, created_at) AT TIME ZONE 'UTC'
FROM applications
WHERE student_resubmit_note IS NOT NULL OR COALESCE(supplemental_files, '') <> ''
ORDER BY id;

-- The latest decision or request (its note is the reviewer_note still stored)
INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note, backfilled, created_at)
SELECT a.id, CASE WHEN a.status = 'needs_info' THEN 'info_requested' ELSE 'decided' END,
       CASE WHEN r.role = 'superadmin' THEN 'admin' ELSE 'reviewer' END, a.reviewed_by,
       a.status, a.reviewer_note, true, COALESCE(a.reviewed_at, a.created_at) AT TIME ZONE 'UTC'
FROM applications a LEFT JOIN users r ON r.id = a.reviewed_by
WHERE a.status <> 'pending'
ORDER BY a.id;
