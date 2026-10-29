-- 004: why a syllabus was required for an application (Group 5), as codes:
-- CREDIT_GAP, CREDIT_SYSTEMS, COMBINED_COURSES. The reviewer screen can translate them
-- (reviewer round); system_note keeps the same reasons as an English sentence for the term book.

ALTER TABLE applications ADD COLUMN syllabus_reasons TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN applications.syllabus_reasons IS
    'Why every fulfilled course needed a syllabus: CREDIT_GAP, CREDIT_SYSTEMS, COMBINED_COURSES (empty = not needed). Written by the server.';
