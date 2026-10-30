-- 006: the student's unsent application form, saved while they type (Group 7), so a closed tab,
-- a crash or an idle logout loses nothing. One draft per student: a new save replaces the old one
-- ("last save wins", also across tabs). Deleted when the student submits, and together with the
-- account (ON DELETE CASCADE).

CREATE TABLE application_drafts (
    student_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE application_drafts IS
    'Unsent application form per student (written by PUT /api/drafts/mine). Only ever read back by that student.';
COMMENT ON COLUMN application_drafts.version IS
    'Format version of data, set by the browser. A draft in another format is discarded, not restored.';
