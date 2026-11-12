-- 023: the committee step's data model (round 2, Group 2 Part B). Runs in one transaction.
--
-- After a REVIEWER or an ADMIN approves or rejects, the application waits for the programme's
-- committee: status 'awaiting_committee'. The committee keeps or changes the decision; only then
-- are status and final_grade the FINAL result. System decisions (no reply by the deadline; old
-- closes) are final at once and never go to the committee.
--
--   status            pending | needs_info | awaiting_committee | approved | rejected | withdrawn
--                     (approved / rejected = final)
--   final_grade       the FINAL grade only (the committee's, or a decision made before 023)
--   reviewer_decision what the reviewer or admin decided: approved | rejected. Never overwritten.
--   reviewer_grade    the grade they gave (only with an approval). Never overwritten.
--   decided_by, decided_by_role, decided_at, decision_rationale: unchanged, the reviewer's or
--                     admin's decision (or System's)
--   committee_state   awaiting | kept | changed | not_needed (System) | before_committee
--                     (decided before this migration: final as it is, never in the committee's list);
--                     NULL while pending, needs info or withdrawn
--   committee_by, committee_by_role (committee | admin), committee_at, committee_note: the step
--
-- Existing decided applications are final as they are: a reviewer's or admin's decision gets
-- reviewer_decision / reviewer_grade copied from status / final_grade and committee_state
-- before_committee; a System decision gets not_needed. Nothing else changes; every count is checked.
-- The duplicate rule (migration 005) also counts applications awaiting the committee, even when
-- the reviewer rejected them: the committee may still approve them.

-- Every status must be a known one before the new rules
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM applications WHERE status NOT IN ('pending', 'needs_info', 'approved', 'rejected', 'withdrawn')) THEN
        RAISE EXCEPTION 'Migration 023: unknown application statuses: %',
            (SELECT string_agg(DISTINCT status, ', ') FROM applications WHERE status NOT IN ('pending', 'needs_info', 'approved', 'rejected', 'withdrawn'));
    END IF;
END $$;

ALTER TABLE applications
    ADD COLUMN reviewer_decision VARCHAR(10),
    ADD COLUMN reviewer_grade SMALLINT,
    ADD COLUMN committee_state VARCHAR(20),
    ADD COLUMN committee_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN committee_by_role VARCHAR(10),
    ADD COLUMN committee_at TIMESTAMPTZ,
    ADD COLUMN committee_note TEXT;

DO $$
DECLARE
    decided_people integer; decided_system integer; decided_unknown integer; open_ones integer;
    moved integer; marked_system integer; marked_unknown integer;
BEGIN
    SELECT count(*) INTO decided_people FROM applications WHERE status IN ('approved', 'rejected') AND decided_by_role IN ('reviewer', 'admin');
    SELECT count(*) INTO decided_system FROM applications WHERE status IN ('approved', 'rejected') AND decided_by_role = 'system';
    SELECT count(*) INTO decided_unknown FROM applications WHERE status IN ('approved', 'rejected') AND decided_by_role IS NULL;
    SELECT count(*) INTO open_ones FROM applications WHERE status NOT IN ('approved', 'rejected');

    -- A reviewer's or admin's decision: copied into its own columns, final as it is
    UPDATE applications SET reviewer_decision = status, reviewer_grade = final_grade, committee_state = 'before_committee'
    WHERE status IN ('approved', 'rejected') AND decided_by_role IN ('reviewer', 'admin');
    GET DIAGNOSTICS moved = ROW_COUNT;
    -- System decisions never go to the committee
    UPDATE applications SET committee_state = 'not_needed' WHERE status IN ('approved', 'rejected') AND decided_by_role = 'system';
    GET DIAGNOSTICS marked_system = ROW_COUNT;
    -- Very old decisions without a record of who decided: final as they are
    UPDATE applications SET committee_state = 'before_committee' WHERE status IN ('approved', 'rejected') AND decided_by_role IS NULL;
    GET DIAGNOSTICS marked_unknown = ROW_COUNT;

    IF moved <> decided_people OR marked_system <> decided_system OR marked_unknown <> decided_unknown THEN
        RAISE EXCEPTION 'Migration 023: decided by people % (marked %), by System % (%), unknown % (%)',
            decided_people, moved, decided_system, marked_system, decided_unknown, marked_unknown;
    END IF;
    IF (SELECT count(*) FROM applications WHERE committee_state IS NULL) <> open_ones THEN
        RAISE EXCEPTION 'Migration 023: an open application got a committee state';
    END IF;
    IF EXISTS (SELECT 1 FROM applications WHERE committee_state = 'before_committee' AND decided_by_role IS NOT NULL
               AND (reviewer_decision IS DISTINCT FROM status OR reviewer_grade IS DISTINCT FROM final_grade)) THEN
        RAISE EXCEPTION 'Migration 023: a copied decision differs from the original';
    END IF;
    RAISE NOTICE 'Migration 023: % decision(s) by a reviewer or admin and % older one(s) final as they are (before the committee); % System decision(s) not needed; % open or withdrawn unchanged.',
        moved, marked_unknown, marked_system, open_ones;
END $$;

-- The rules
ALTER TABLE applications
    ADD CONSTRAINT applications_status_known CHECK (status IN ('pending', 'needs_info', 'awaiting_committee', 'approved', 'rejected', 'withdrawn')),
    DROP CONSTRAINT applications_decision_only_when_decided,
    ADD CONSTRAINT applications_decision_only_when_decided CHECK (decided_at IS NULL OR status IN ('approved', 'rejected', 'awaiting_committee')),
    -- The reviewer's (or admin's) decision is recorded exactly when they decided
    ADD CONSTRAINT applications_reviewer_decision_known CHECK (reviewer_decision IS NULL OR reviewer_decision IN ('approved', 'rejected')),
    ADD CONSTRAINT applications_reviewer_decision_by_people CHECK (reviewer_decision IS NULL OR decided_by_role IN ('reviewer', 'admin')),
    ADD CONSTRAINT applications_reviewer_grade_range CHECK (reviewer_grade IS NULL OR reviewer_grade BETWEEN 2 AND 5),
    ADD CONSTRAINT applications_reviewer_grade_with_approval CHECK ((reviewer_grade IS NOT NULL) = (reviewer_decision IS NOT DISTINCT FROM 'approved')),
    -- Waiting for the committee: the reviewer's decision is there, no final grade yet
    ADD CONSTRAINT applications_awaiting_has_decision CHECK (status <> 'awaiting_committee' OR (reviewer_decision IS NOT NULL AND final_grade IS NULL)),
    -- The committee state matches the status
    ADD CONSTRAINT applications_committee_state_known CHECK (committee_state IS NULL OR committee_state IN ('awaiting', 'kept', 'changed', 'not_needed', 'before_committee')),
    ADD CONSTRAINT applications_committee_state_matches CHECK (
        CASE
            WHEN status = 'awaiting_committee' THEN committee_state = 'awaiting'
            WHEN status IN ('approved', 'rejected') THEN committee_state IN ('kept', 'changed', 'not_needed', 'before_committee')
            ELSE committee_state IS NULL
        END),
    -- The committee step: all of it or nothing, and only when it was taken
    ADD CONSTRAINT applications_committee_by_role_known CHECK (committee_by_role IS NULL OR committee_by_role IN ('committee', 'admin')),
    ADD CONSTRAINT applications_committee_step_complete CHECK ((committee_at IS NULL) = (committee_by_role IS NULL)),
    ADD CONSTRAINT applications_committee_step_taken CHECK ((committee_at IS NOT NULL) = (committee_state IS NOT DISTINCT FROM 'kept' OR committee_state IS NOT DISTINCT FROM 'changed')),
    -- A changed decision always says why
    ADD CONSTRAINT applications_committee_change_has_note CHECK (committee_state IS DISTINCT FROM 'changed' OR length(trim(coalesce(committee_note, ''))) > 0);

-- The duplicate rule (migration 005): also counts applications awaiting the committee
DROP INDEX applications_one_active_per_course;
CREATE UNIQUE INDEX applications_one_active_per_course ON applications (student_id, programme_id, target_course_code)
    WHERE status IN ('pending', 'needs_info', 'awaiting_committee', 'approved');

-- The history: the committee's step
ALTER TABLE application_events DROP CONSTRAINT application_events_kind_check;
ALTER TABLE application_events ADD CONSTRAINT application_events_kind_check
    CHECK (kind IN ('submitted', 'info_requested', 'replied', 'decided', 'withdrawn', 'auto_rejected', 'committee_kept', 'committee_changed'));

CREATE INDEX applications_awaiting_committee_idx ON applications (programme_id) WHERE status = 'awaiting_committee';

COMMENT ON COLUMN applications.status IS 'pending, needs_info, awaiting_committee (a reviewer or admin decided; the committee confirms), approved / rejected (FINAL), withdrawn.';
COMMENT ON COLUMN applications.final_grade IS 'The FINAL grade (2-5) of an approval: the committee''s, or a decision made before the committee existed. Empty while awaiting the committee.';
COMMENT ON COLUMN applications.reviewer_decision IS 'What the reviewer or admin decided (approved / rejected), kept for good; the final result is status.';
COMMENT ON COLUMN applications.reviewer_grade IS 'The grade the reviewer or admin gave with an approval, kept for good; the final grade is final_grade.';
COMMENT ON COLUMN applications.committee_state IS 'awaiting / kept / changed / not_needed (System decision) / before_committee (decided before the committee existed, migration 023). NULL while pending, needs info or withdrawn.';
