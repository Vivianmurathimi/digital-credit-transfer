-- 011: an approval always has a final grade (reviewer Group 6).
--
-- Migration 009 prepared final_grade (2-5, only on approved applications). From now on the
-- decision panel requires it, and so does the database. Approved applications from before this
-- (if any) have no grade and none is invented for them: then the rule is added NOT VALID, so it
-- holds for every new or changed row, and those old ones keep showing "—".

DO $$
DECLARE
    without_grade integer;
BEGIN
    SELECT count(*) INTO without_grade FROM applications WHERE status = 'approved' AND final_grade IS NULL;

    IF without_grade = 0 THEN
        ALTER TABLE applications
            ADD CONSTRAINT applications_approved_has_grade CHECK (status <> 'approved' OR final_grade IS NOT NULL);
        RAISE NOTICE 'Migration 011: 0 approved application(s) without a final grade; the rule holds for every row';
    ELSE
        ALTER TABLE applications
            ADD CONSTRAINT applications_approved_has_grade CHECK (status <> 'approved' OR final_grade IS NOT NULL) NOT VALID;
        RAISE NOTICE 'Migration 011: % approved application(s) from before have no final grade and keep none (shown as "—"); the rule holds for every new or changed row', without_grade;
    END IF;
END $$;

COMMENT ON CONSTRAINT applications_approved_has_grade ON applications IS 'An approval needs a final grade (2-5). NOT VALID only if older approvals without a grade existed when it was added.';
