-- 003: institutions on applications (Group 4). The student enters each previous institution
-- once (name, country, grading-system file); every fulfilled-course row in
-- fulfilled_courses_json points to one of them by position ("institution": 0, 1, ...).
--
-- Stored as: [{ "name": "TU Wien", "country": "AT", "grading_file": "<stored file name>" }, ...]
-- "country" is an ISO 3166-1 alpha-2 code (see backend/utils/countries.js).

ALTER TABLE applications ADD COLUMN institutions JSONB;

COMMENT ON COLUMN applications.institutions IS
    'Previous institutions [{name, country, grading_file}], referenced by position from fulfilled_courses_json rows. NULL for applications submitted before Group 4.';
