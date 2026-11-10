-- 018: closing the semester (admin round, Group 6). Runs in one transaction.
--
-- Closing is an admin click, never automatic (the background job's end-of-semester step is gone).
-- In one transaction it rejects the semester's pending and needs-info applications as System
-- (reason SEMESTER_ENDED), ends its late access, deletes unsent drafts and sets the semester
-- closed. After that the PDF book is generated; these columns remember it, or why it failed, so
-- the admin can generate it again without reopening anything.
-- draft_reminders: the "your draft hasn't been submitted" email, once per student and semester,
-- sent when the last-days warning starts.

ALTER TABLE semesters
    ADD COLUMN book_name VARCHAR(200),
    ADD COLUMN book_generated_at TIMESTAMPTZ,
    ADD COLUMN book_error VARCHAR(500);

COMMENT ON COLUMN semesters.book_name IS 'The semester''s PDF book in the private archive bucket (generated after the close).';
COMMENT ON COLUMN semesters.book_error IS 'Why the last PDF generation failed (shown to the admin, with "Generate PDF again"); NULL when it worked.';

CREATE TABLE draft_reminders (
    semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sent_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (semester_id, student_id)
);

COMMENT ON TABLE draft_reminders IS 'One "your draft has not been submitted" email per student and semester, recorded before it is sent (never twice).';
