-- 026: other codes of a programme (fixes, Group 1b). Runs in one transaction.
--
-- The Neptun import now brings in one programme at a time: the admin chooses the programme first
-- (an existing one, or a new one checked against the existing ones), then uploads the CSV, and every
-- row is checked against that programme. Rows written with another code ("CIVIL" when CIV was
-- chosen) stop the import until the admin answers "Treat as the same programme" or cancels. That
-- answer is remembered here, so the next import with that code goes through without asking.
--
--   programme_aliases   another code a programme is imported under. alias_code is stored in capitals,
--                       in the same format as a programme code, and is unique: one code always means
--                       one programme. The server also refuses an alias that is a programme's own code.
-- Nothing is copied or deleted: no alias exists yet.

CREATE TABLE programme_aliases (
    id SERIAL PRIMARY KEY,
    programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
    alias_code VARCHAR(20) NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT programme_aliases_code_unique UNIQUE (alias_code),
    CONSTRAINT programme_aliases_code_format CHECK (alias_code ~ '^[A-Z0-9_-]{1,20}$')
);
CREATE INDEX programme_aliases_programme_id_idx ON programme_aliases (programme_id);
COMMENT ON TABLE programme_aliases IS 'Other codes a programme is imported under, saved when the admin answers "Treat as the same programme" in the Neptun import; later imports with that code match without asking.';

DO $$
DECLARE
    programmes_count integer; aliases_count integer;
BEGIN
    SELECT count(*) INTO programmes_count FROM programmes;
    SELECT count(*) INTO aliases_count FROM programme_aliases;
    IF aliases_count <> 0 THEN
        RAISE EXCEPTION 'Migration 026: expected no alias, found %', aliases_count;
    END IF;
    RAISE NOTICE 'Migration 026: % programme(s) unchanged; programme aliases are ready.', programmes_count;
END $$;
