-- 009: the decision on an application (reviewer side, Group 1).
--
-- One application = one target PTE course, so there is one decision per application.
-- The decision columns are set only when an application is approved or rejected (by a reviewer,
-- an admin or the system) and cleared when it goes back to review; the full story stays in
-- application_events. reviewed_by / reviewed_at are unchanged: they still record the latest
-- status change of any kind.
--
-- Fulfilled courses stay in applications.fulfilled_courses_json (JSONB), as the student side
-- stores them; the reviewer side only reads them.

ALTER TABLE applications
    ADD COLUMN final_grade SMALLINT,
    ADD COLUMN decided_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN decided_by_role VARCHAR(20),
    ADD COLUMN decided_at TIMESTAMPTZ,
    ADD COLUMN decision_rationale TEXT,
    ADD COLUMN assigned_reviewer_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE applications
    -- The PTE grade given on approval: 2 (elégséges) to 5 (jeles). "Required on approve" comes with the decision screen.
    ADD CONSTRAINT applications_final_grade_range CHECK (final_grade BETWEEN 2 AND 5),
    ADD CONSTRAINT applications_final_grade_only_approved CHECK (final_grade IS NULL OR status = 'approved'),
    ADD CONSTRAINT applications_decided_by_role_known CHECK (decided_by_role IN ('reviewer', 'admin', 'system')),
    -- A decision has a role and a time together; the system is nobody
    ADD CONSTRAINT applications_decision_complete CHECK ((decided_by_role IS NULL) = (decided_at IS NULL)),
    ADD CONSTRAINT applications_system_decides_alone CHECK (decided_by_role IS DISTINCT FROM 'system' OR decided_by IS NULL),
    ADD CONSTRAINT applications_decision_only_when_decided CHECK (decided_at IS NULL OR status IN ('approved', 'rejected'));

-- Indexes for the foreign keys (also keep "may this user be deleted?" checks fast)
CREATE INDEX applications_assigned_reviewer_id_idx ON applications (assigned_reviewer_id);
CREATE INDEX applications_decided_by_idx ON applications (decided_by);

COMMENT ON COLUMN applications.final_grade IS 'PTE grade 2-5 given on approval (NULL otherwise).';
COMMENT ON COLUMN applications.decided_by IS 'Who approved or rejected it (NULL for the system). Users with decisions cannot be deleted: they are deactivated instead, so their name stays on the record.';
COMMENT ON COLUMN applications.decided_by_role IS 'reviewer, admin or system. Set only for approved / rejected.';
COMMENT ON COLUMN applications.decided_at IS 'When it was approved or rejected.';
COMMENT ON COLUMN applications.decision_rationale IS 'The reason given with the approval or rejection, shown to the student. Automatic rejections store their reason text.';
COMMENT ON COLUMN applications.assigned_reviewer_id IS 'The reviewer responsible for it (assignment comes later). Reviewers are deactivated, never deleted.';

-- Existing decided applications: their latest decision from the history
UPDATE applications a
SET decided_by = CASE WHEN e.actor_role = 'system' THEN NULL ELSE e.actor_id END,
    decided_by_role = e.actor_role,
    decided_at = e.created_at,
    decision_rationale = e.note
FROM (
    SELECT DISTINCT ON (application_id) application_id, actor_role, actor_id, created_at, note, status
    FROM application_events
    WHERE kind IN ('decided', 'auto_rejected') AND status IN ('approved', 'rejected')
    ORDER BY application_id, created_at DESC, id DESC
) e
WHERE e.application_id = a.id AND e.status = a.status AND a.status IN ('approved', 'rejected')
  AND e.actor_role IN ('reviewer', 'admin', 'system');

-- Every note in order, one row each, read-only: a view over the append-only history.
-- note_type: student (with the application), resubmit (the student's reply), reviewer (request for
-- information or decision by a reviewer or admin), system (automatic rejection reason).
CREATE VIEW application_notes AS
SELECT e.id,
       e.application_id,
       e.actor_id AS author_id,
       e.actor_role AS author_role,
       CASE
           WHEN e.kind = 'submitted' THEN 'student'
           WHEN e.kind = 'replied' THEN 'resubmit'
           WHEN e.actor_role = 'system' THEN 'system'
           ELSE 'reviewer'
       END AS note_type,
       e.kind AS event_kind,
       e.note AS text,
       e.created_at
FROM application_events e
WHERE e.note IS NOT NULL AND btrim(e.note) <> '';

COMMENT ON VIEW application_notes IS 'Every note of every application in order (from application_events). Read-only.';

-- A simple view could otherwise be written through: refuse it, like the history itself
CREATE FUNCTION application_notes_read_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'application_notes is read-only: notes are added as application_events'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_notes_read_only
    INSTEAD OF INSERT OR UPDATE OR DELETE ON application_notes
    FOR EACH ROW EXECUTE FUNCTION application_notes_read_only();
