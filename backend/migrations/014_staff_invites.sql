-- 014: admins and reviewers only by invite (admin round, Group 2).
--
-- 1. Invites are for reviewers AND admins: reviewer_invites becomes staff_invites, with a role.
--    A reviewer invite names one programme; an admin invite names none. The invite's status is
--    not stored: it is worked out when read (accepted / cancelled / expired / sent) from
--    accepted_at, cancelled_at and expires_at, so no job is needed to mark invites as expired.
-- 2. Admins can be deactivated too: users.reviewer_deactivated_at becomes deactivated_at, allowed
--    for reviewers and superadmins. A deactivated account keeps its id and name (past decisions
--    stay linked); inviting its address again reactivates the same account.
--
-- Nothing is dropped: the rows, ids and values stay as they are, only names change.

-- ---------- 1. staff_invites ----------
ALTER TABLE reviewer_invites RENAME TO staff_invites;
ALTER SEQUENCE reviewer_invites_id_seq RENAME TO staff_invites_id_seq;

-- Constraint and index names follow the table name
DO $$
DECLARE
    item record;
BEGIN
    FOR item IN SELECT conname FROM pg_constraint WHERE conrelid = 'staff_invites'::regclass AND conname LIKE 'reviewer\_invites\_%' LOOP
        EXECUTE format('ALTER TABLE staff_invites RENAME CONSTRAINT %I TO %I', item.conname, replace(item.conname, 'reviewer_invites_', 'staff_invites_'));
    END LOOP;
    FOR item IN SELECT indexname FROM pg_indexes WHERE tablename = 'staff_invites' AND indexname LIKE 'reviewer\_invites\_%' LOOP
        EXECUTE format('ALTER INDEX %I RENAME TO %I', item.indexname, replace(item.indexname, 'reviewer_invites_', 'staff_invites_'));
    END LOOP;
END $$;

-- Every existing invite was a reviewer invite. No default afterwards: each new invite says its role.
ALTER TABLE staff_invites ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'reviewer';
ALTER TABLE staff_invites ALTER COLUMN role DROP DEFAULT;
ALTER TABLE staff_invites ALTER COLUMN programme_id DROP NOT NULL;
ALTER TABLE staff_invites
    ADD CONSTRAINT staff_invites_role_known CHECK (role IN ('reviewer', 'superadmin')),
    ADD CONSTRAINT staff_invites_programme_for_reviewers CHECK ((role = 'reviewer') = (programme_id IS NOT NULL)),
    ADD CONSTRAINT staff_invites_replace_only_reviewers CHECK (role = 'reviewer' OR replace_reviewer = false);

COMMENT ON TABLE staff_invites IS 'Invitations for reviewers (one programme) and admins, sent by the superadmin. Valid 7 days, single use; the link token is stored hashed. Status is worked out when read: accepted / cancelled / expired / sent.';
COMMENT ON COLUMN staff_invites.role IS 'reviewer or superadmin: the role the accepted account gets.';
COMMENT ON COLUMN staff_invites.programme_id IS 'The programme a reviewer invite is for; NULL for an admin invite.';

-- ---------- 2. users.deactivated_at ----------
ALTER TABLE users RENAME COLUMN reviewer_deactivated_at TO deactivated_at;
ALTER TABLE users DROP CONSTRAINT users_deactivation_only_reviewers;
ALTER TABLE users ADD CONSTRAINT users_deactivation_only_staff CHECK (deactivated_at IS NULL OR role IN ('reviewer', 'superadmin'));

COMMENT ON COLUMN users.deactivated_at IS 'Set when the superadmin removes a reviewer or deactivates an admin: no access any more, but the account and its name stay on old decisions. NULL = active.';
