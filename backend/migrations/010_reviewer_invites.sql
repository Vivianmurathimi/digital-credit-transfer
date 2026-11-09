-- 010: reviewer access (reviewer side, Group 2).
--
-- Reviewers no longer register themselves: the superadmin invites them by email for one
-- programme. Each programme has at most one ACTIVE reviewer. A removed reviewer keeps
-- role = 'reviewer' and their programme (so their name stays on their decisions) but gets
-- reviewer_deactivated_at, which ends their access and frees the programme for a new reviewer.
-- Accepting an invite for a deactivated reviewer's email reactivates that same account.
--
-- Existing reviewers stay reviewers of their programme. Open applications are assigned to
-- their programme's reviewer.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE role = 'reviewer' AND programme_id IS NULL) THEN
        RAISE EXCEPTION 'Migration 010: every reviewer needs a programme. Set users.programme_id for these reviewers first: %',
            (SELECT string_agg(email, ', ') FROM users WHERE role = 'reviewer' AND programme_id IS NULL);
    END IF;
    IF EXISTS (SELECT 1 FROM users WHERE role = 'reviewer' GROUP BY programme_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Migration 010: a programme has more than one reviewer (%). Change the extra ones to another role first.',
            (SELECT string_agg(email, ', ') FROM users WHERE role = 'reviewer'
             AND programme_id IN (SELECT programme_id FROM users WHERE role = 'reviewer' GROUP BY programme_id HAVING count(*) > 1));
    END IF;
END $$;

ALTER TABLE users
    ADD COLUMN reviewer_deactivated_at TIMESTAMPTZ,
    ADD CONSTRAINT users_deactivation_only_reviewers CHECK (reviewer_deactivated_at IS NULL OR role = 'reviewer'),
    ADD CONSTRAINT users_reviewers_have_programme CHECK (role <> 'reviewer' OR programme_id IS NOT NULL);

COMMENT ON COLUMN users.reviewer_deactivated_at IS 'Set when the superadmin removes a reviewer: no access any more, but the account and its name stay on old decisions. NULL = active.';

-- One active reviewer per programme (deactivated reviewers don't count)
CREATE UNIQUE INDEX users_one_active_reviewer_per_programme ON users (programme_id)
    WHERE role = 'reviewer' AND reviewer_deactivated_at IS NULL;

-- Invites. Only a SHA-256 hash of the link's token is stored, never the token itself.
CREATE TABLE reviewer_invites (
    id SERIAL PRIMARY KEY,
    email VARCHAR(100) NOT NULL CHECK (email = lower(email)),
    programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE RESTRICT,
    replace_reviewer BOOLEAN NOT NULL DEFAULT false,
    language VARCHAR(5) NOT NULL DEFAULT 'hu' CHECK (language IN ('hu', 'en', 'de')),
    token_hash CHAR(64) NOT NULL UNIQUE,
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at TIMESTAMPTZ,
    CONSTRAINT reviewer_invites_closed_once CHECK (accepted_at IS NULL OR cancelled_at IS NULL),
    CONSTRAINT reviewer_invites_accepted_by_someone CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL))
);

-- At most one open invite per email (a new invite or a resend replaces the old one)
CREATE UNIQUE INDEX reviewer_invites_one_open_per_email ON reviewer_invites (email)
    WHERE accepted_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX reviewer_invites_programme_id_idx ON reviewer_invites (programme_id);

COMMENT ON TABLE reviewer_invites IS 'Reviewer invitations sent by the superadmin. Valid 7 days, single use; the link token is stored hashed.';
COMMENT ON COLUMN reviewer_invites.language IS 'Language of the invite email (and of a resend); becomes the new account''s language.';
COMMENT ON COLUMN reviewer_invites.replace_reviewer IS 'true: accepting it deactivates the programme''s current reviewer. false: refused while the programme has one.';

-- Existing applications: open ones belong to their programme's reviewer, decided ones to the
-- reviewer who decided them (decisions by the admin or the system stay unassigned)
DO $$
DECLARE
    reviewers integer;
    open_assigned integer;
    decided_assigned integer;
BEGIN
    SELECT count(*) INTO reviewers FROM users WHERE role = 'reviewer';

    UPDATE applications a SET assigned_reviewer_id = u.id
    FROM users u
    WHERE u.role = 'reviewer' AND u.programme_id = a.programme_id
      AND a.status IN ('pending', 'needs_info') AND a.assigned_reviewer_id IS NULL;
    GET DIAGNOSTICS open_assigned = ROW_COUNT;

    UPDATE applications SET assigned_reviewer_id = decided_by
    WHERE decided_by_role = 'reviewer' AND decided_by IS NOT NULL AND assigned_reviewer_id IS NULL;
    GET DIAGNOSTICS decided_assigned = ROW_COUNT;

    RAISE NOTICE 'Migration 010: % existing reviewer(s) kept as active reviewers of their programme (no user rows changed)', reviewers;
    RAISE NOTICE 'Migration 010: % open application(s) assigned to their programme''s reviewer, % decided application(s) to the reviewer who decided them',
        open_assigned, decided_assigned;
END $$;
