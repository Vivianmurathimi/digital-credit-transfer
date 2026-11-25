-- 025: activating and deleting staff accounts (fixes, Group 1a). Runs in one transaction.
--
-- Until now a deactivated reviewer, committee member or admin could only come back through a new
-- invite: a new password, and only the programmes typed into that invite. Now the admin can
-- ACTIVATE the same account (same password, same history) and DELETE one.
--
--   staff_programmes.ended_by_deactivation   true = this link ended BECAUSE its account was
--                                            deactivated (removed reviewer or committee member,
--                                            or someone swapped out of their last programme).
--                                            Activate gives exactly these links back. Links the
--                                            admin ended one by one stay ended.
--   users.deleted_at                         the admin deleted the account, but it has history
--                                            (decisions, committee steps, history entries...),
--                                            so the row stays: the name stays on those records
--                                            and in the PDF book. It is also deactivated (a rule),
--                                            hidden from every list, and its email is replaced by
--                                            a placeholder (deleted-<id>@invalid), so the address
--                                            can be invited again as a new account. An account
--                                            without history is deleted for real instead.
--
-- Existing links are marked when they ended at the very moment their account was deactivated
-- (both are written in the same transaction, so the times are equal). Nothing is deleted.

ALTER TABLE staff_programmes ADD COLUMN ended_by_deactivation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE staff_programmes ADD CONSTRAINT staff_programmes_deactivation_ended
    CHECK (NOT ended_by_deactivation OR ended_at IS NOT NULL);
COMMENT ON COLUMN staff_programmes.ended_by_deactivation IS 'The link ended because its account was deactivated; activating the account gives it back (as a new link row, this one stays as history).';

ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD CONSTRAINT users_deleted_is_deactivated
    CHECK (deleted_at IS NULL OR deactivated_at IS NOT NULL);
COMMENT ON COLUMN users.deleted_at IS 'Deleted by the admin but kept for its history: deactivated, hidden from every list, email replaced by deleted-<id>@invalid.';

DO $$
DECLARE
    deactivated integer; marked integer; total_links integer; total_users integer;
BEGIN
    SELECT count(*) INTO total_links FROM staff_programmes;
    SELECT count(*) INTO total_users FROM users;
    SELECT count(*) INTO deactivated FROM users WHERE deactivated_at IS NOT NULL;

    UPDATE staff_programmes sp SET ended_by_deactivation = true
    FROM users u
    WHERE u.id = sp.user_id AND u.deactivated_at IS NOT NULL AND sp.ended_at = u.deactivated_at;
    GET DIAGNOSTICS marked = ROW_COUNT;

    IF (SELECT count(*) FROM staff_programmes) <> total_links OR (SELECT count(*) FROM users) <> total_users THEN
        RAISE EXCEPTION 'Migration 025: row counts changed (links %, users %)', total_links, total_users;
    END IF;
    IF EXISTS (SELECT 1 FROM staff_programmes WHERE ended_by_deactivation AND ended_at IS NULL) THEN
        RAISE EXCEPTION 'Migration 025: a current link was marked as ended by deactivation';
    END IF;
    RAISE NOTICE 'Migration 025: % deactivated account(s); % link(s) marked as ended by their deactivation (given back on Activate); % link(s) and % account(s) unchanged otherwise.',
        deactivated, marked, total_links, total_users;
END $$;
