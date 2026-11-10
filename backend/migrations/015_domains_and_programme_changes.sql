-- 015: students and domains (admin round, Group 3).
--
-- 1. allowed_domains: the email domains students may register from. Registration always creates
--    a student, and only when the address's domain EXACTLY matches a listed one. Removing a domain
--    blocks new sign-ups only; existing accounts keep working (login never checks the domain).
--    No domain is written in the code: the starting list is copied from the domains of existing
--    STUDENT accounts (reviewers and admins are invited, so their domains are not added). With no
--    students yet the list starts empty, and the admin dashboard warns that nobody can register.
-- 2. student_programme_changes: every time the admin moves a student to another programme
--    (who, from, to, when, how many open applications were withdrawn). Rows are only ever added.

CREATE TABLE allowed_domains (
    id SERIAL PRIMARY KEY,
    domain VARCHAR(253) NOT NULL UNIQUE,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT allowed_domains_lowercase CHECK (domain = lower(domain)),
    CONSTRAINT allowed_domains_host_name CHECK (domain ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);

COMMENT ON TABLE allowed_domains IS 'Email domains students may register from (exact match, e.g. an address @x.hu needs x.hu here; sub.x.hu does not count). Managed by the superadmin.';
COMMENT ON COLUMN allowed_domains.added_by IS 'The admin who added it; NULL for the starting list copied from existing student accounts.';

-- The starting list: the domains existing students registered with
INSERT INTO allowed_domains (domain)
SELECT DISTINCT lower(split_part(email, '@', 2))
FROM users
WHERE role = 'student'
  AND lower(split_part(email, '@', 2)) ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
ON CONFLICT (domain) DO NOTHING;

CREATE TABLE student_programme_changes (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    old_programme_id INTEGER REFERENCES programmes(id) ON DELETE RESTRICT,
    new_programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE RESTRICT,
    changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    withdrawn_count INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn_count >= 0),
    draft_removed BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT student_programme_changes_really_changes CHECK (old_programme_id IS DISTINCT FROM new_programme_id)
);

CREATE INDEX student_programme_changes_student_idx ON student_programme_changes (student_id, changed_at DESC);

COMMENT ON TABLE student_programme_changes IS 'Each programme change the admin made for a student: from, to, who, when, and how many open applications (pending, needs info; current semester) were withdrawn with reason PROGRAMME_CHANGED.';

-- Only ever added to, like the application history
CREATE FUNCTION student_programme_changes_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'student_programme_changes is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER student_programme_changes_no_update
    BEFORE UPDATE ON student_programme_changes
    FOR EACH ROW EXECUTE FUNCTION student_programme_changes_append_only();
