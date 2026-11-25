-- 027: the committee can change the grade (fixes, committee Part A). Runs in one transaction.
--
-- Until now the committee could only Keep or Change the decision (approved <-> rejected); Keep on an
-- approval also quietly accepted another grade. Now an approval gets three choices: Keep (the
-- reviewer's grade stays), Change the grade (still approved, another grade, no note needed), or
-- Change to rejected. A rejection: Keep, or Change to approved (a grade is required).
--
--   applications.committee_grade   the grade the committee set (Change the grade, or Change to
--                                  approved). final_grade stays the FINAL grade: the committee's if
--                                  set, otherwise the reviewer's (reviewer_grade). A grade change is
--                                  committee_state 'changed' with the decision still approved.
--
-- Existing rows, nothing deleted:
--   - changed from rejected to approved: committee_grade = their final grade
--   - kept, but with another grade than the reviewer's (the old Keep): that was a grade change, so
--     committee_state becomes 'changed' with committee_grade = their final grade. Their history entry
--     stays "kept" (history is append-only).
-- The note is now required only when the decision itself changes (approved <-> rejected).

ALTER TABLE applications ADD COLUMN committee_grade SMALLINT;
COMMENT ON COLUMN applications.committee_grade IS 'The grade the committee set: Change the grade, or Change to approved. NULL when the committee kept the decision or rejected. final_grade = committee_grade if set, otherwise reviewer_grade.';

-- The old rule (a change always has a note) is replaced below: drop it before the old Keeps become changes
ALTER TABLE applications DROP CONSTRAINT applications_committee_change_has_note;

DO $$
DECLARE
    total integer; to_approved integer; regraded integer; filled integer; moved integer; after_total integer;
BEGIN
    SELECT count(*) INTO total FROM applications;
    SELECT count(*) INTO to_approved FROM applications
        WHERE committee_state = 'changed' AND status = 'approved' AND reviewer_decision = 'rejected';
    SELECT count(*) INTO regraded FROM applications
        WHERE committee_state = 'kept' AND status = 'approved' AND final_grade IS DISTINCT FROM reviewer_grade;

    UPDATE applications SET committee_grade = final_grade
        WHERE committee_state = 'changed' AND status = 'approved' AND reviewer_decision = 'rejected';
    GET DIAGNOSTICS filled = ROW_COUNT;
    UPDATE applications SET committee_grade = final_grade, committee_state = 'changed'
        WHERE committee_state = 'kept' AND status = 'approved' AND final_grade IS DISTINCT FROM reviewer_grade;
    GET DIAGNOSTICS moved = ROW_COUNT;

    SELECT count(*) INTO after_total FROM applications;
    IF filled <> to_approved OR moved <> regraded OR after_total <> total THEN
        RAISE EXCEPTION 'Migration 027: expected % and % rows, changed % and %; % applications before, % after', to_approved, regraded, filled, moved, total, after_total;
    END IF;
    RAISE NOTICE 'Migration 027: % application(s); % changed to approved got their committee grade; % kept with another grade became a grade change.', total, filled, moved;
END $$;

ALTER TABLE applications
    ADD CONSTRAINT applications_committee_grade_range CHECK (committee_grade IS NULL OR committee_grade BETWEEN 2 AND 5),
    -- Only a change that ends approved has a committee grade
    ADD CONSTRAINT applications_committee_grade_on_change CHECK (committee_grade IS NULL OR (committee_state = 'changed' AND status = 'approved')),
    -- After the committee, the final grade is the committee's if set, otherwise the reviewer's
    ADD CONSTRAINT applications_committee_final_grade CHECK (
        committee_state IS DISTINCT FROM 'kept' AND committee_state IS DISTINCT FROM 'changed' OR status <> 'approved'
        OR final_grade = COALESCE(committee_grade, reviewer_grade)),
    -- A grade change gives another grade than the reviewer's; a change to approved gives one
    ADD CONSTRAINT applications_committee_change_to_approved_grade CHECK (
        committee_state IS DISTINCT FROM 'changed' OR status <> 'approved'
        OR (committee_grade IS NOT NULL AND committee_grade IS DISTINCT FROM reviewer_grade)),
    -- Changing the decision itself (approved <-> rejected) always says why; a grade change need not
    ADD CONSTRAINT applications_committee_flip_has_note CHECK (
        committee_state IS DISTINCT FROM 'changed' OR status = reviewer_decision OR length(trim(coalesce(committee_note, ''))) > 0);
