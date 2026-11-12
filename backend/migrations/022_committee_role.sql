-- 022: the committee role (round 2, Group 2 Part A). Runs in one transaction.
--
-- After a reviewer (or an admin) decides, the programme's committee confirms it (Part B on). This
-- migration only lets committee members exist:
--   - users.role 'committee': someone who is ONLY on a committee. A reviewer can ALSO sit on a
--     committee: the same account with committee links (no second account).
--   - staff_programmes role 'committee' (as migration 019 planned: one CHECK widened, same shape).
--     A member may be linked to any number of programmes; a programme may have any number of
--     members; there is no "main" among them. Their access always comes from their CURRENT links.
--   - one current link per person, programme and SIDE (reviewer side: main or extra; committee),
--     so someone can be a programme's reviewer and a member of its committee at the same time
--     (they may still never confirm their own decision: checked on the server, Part C).
--   - staff invites can be for the committee; committee members can be deactivated like other
--     staff; the admin can act as a committee member; the history knows the actor 'committee'.
-- No row changes: every count is checked to stay the same.

DO $$
DECLARE
    links_before integer; links_after integer; invites_before integer; invites_after integer;
BEGIN
    SELECT count(*) INTO links_before FROM staff_programmes;
    SELECT count(*) INTO invites_before FROM staff_invite_programmes;

    ALTER TABLE staff_programmes DROP CONSTRAINT staff_programmes_role_known;
    ALTER TABLE staff_programmes ADD CONSTRAINT staff_programmes_role_known CHECK (role IN ('main', 'extra', 'committee'));
    DROP INDEX staff_programmes_one_current_link;
    CREATE UNIQUE INDEX staff_programmes_one_current_link ON staff_programmes (user_id, programme_id, (role = 'committee')) WHERE ended_at IS NULL;

    ALTER TABLE staff_invite_programmes DROP CONSTRAINT staff_invite_programmes_role_known;
    ALTER TABLE staff_invite_programmes ADD CONSTRAINT staff_invite_programmes_role_known CHECK (role IN ('main', 'extra', 'committee'));

    ALTER TABLE staff_invites DROP CONSTRAINT staff_invites_role_known;
    ALTER TABLE staff_invites ADD CONSTRAINT staff_invites_role_known CHECK (role IN ('reviewer', 'superadmin', 'committee'));

    ALTER TABLE users DROP CONSTRAINT users_deactivation_only_staff;
    ALTER TABLE users ADD CONSTRAINT users_deactivation_only_staff CHECK (deactivated_at IS NULL OR role IN ('reviewer', 'superadmin', 'committee'));

    ALTER TABLE acting_sessions DROP CONSTRAINT acting_sessions_person_role_check;
    ALTER TABLE acting_sessions ADD CONSTRAINT acting_sessions_person_role_check CHECK (person_role IN ('student', 'reviewer', 'committee'));

    ALTER TABLE application_events DROP CONSTRAINT application_events_actor_role_check;
    ALTER TABLE application_events ADD CONSTRAINT application_events_actor_role_check CHECK (actor_role IN ('student', 'reviewer', 'admin', 'system', 'committee'));

    SELECT count(*) INTO links_after FROM staff_programmes;
    SELECT count(*) INTO invites_after FROM staff_invite_programmes;
    IF links_after <> links_before OR invites_after <> invites_before THEN
        RAISE EXCEPTION 'Migration 022: links % -> %, invite programmes % -> %', links_before, links_after, invites_before, invites_after;
    END IF;
    RAISE NOTICE 'Migration 022: committee role allowed; % link(s) and % invite programme(s) unchanged.', links_after, invites_after;
END $$;

COMMENT ON TABLE staff_programmes IS 'Which staff work on which programme, and how: main reviewer (sees and decides everything; one per programme), extra reviewer (sees the programme only while can_assist is on), or committee member (confirms the reviewers'' decisions; any number, no main). One current link per person, programme and side (reviewer / committee). ended_at set = the link has ended; the row stays for history.';
