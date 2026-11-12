-- 019: staff linked to programmes (round 2, Group 1 Part B). Runs in one transaction.
--
-- Until now a reviewer's programme was users.programme_id, and the database allowed one active
-- reviewer per programme. From now on:
--   - staff_programmes links staff to programmes: one row per person, programme and role.
--     role 'main' or 'extra' (Group 2 adds 'committee' by widening one CHECK; the shape stays).
--     A reviewer may be linked to any number of programmes.
--   - per programme at most ONE current main reviewer (a database rule) and any number of extra
--     reviewers; an extra reviewer sees the programme only while can_assist is on (default off).
--   - ended_at: the link has ended (removed, swapped, deactivated). Ended links stay, so history,
--     "Decided by" and per-programme reports still find a former reviewer's programme.
--   - users.programme_id is for students only (a database rule), so no code can read a
--     reviewer's old programme by mistake.
--   - staff invites name their programme(s) and the role in each (staff_invite_programmes).
--
-- Moved, nothing lost:
--   - every reviewer -> a 'main' link to their programme (current for active reviewers, ended
--     at their deactivation for deactivated ones); then their users.programme_id is cleared.
--   - every reviewer invite -> one 'main' row with its replace flag; then the invite's own
--     programme_id and replace_reviewer columns are dropped.
--   - open (pending, needs_info) applications assigned to a reviewer become shared (NULL): with
--     only a main reviewer nothing changes, the main reviewer sees everything. Decided ones keep
--     theirs; who decided stays in decided_by.
-- Every step's row count is checked; any difference stops the migration (nothing is applied).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users WHERE role NOT IN ('student', 'reviewer') AND programme_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Migration 019: only students and reviewers may have a programme. Clear users.programme_id for: %',
            (SELECT string_agg(email, ', ') FROM users WHERE role NOT IN ('student', 'reviewer') AND programme_id IS NOT NULL);
    END IF;
    IF EXISTS (SELECT 1 FROM users WHERE role = 'reviewer' AND programme_id IS NULL) THEN
        RAISE EXCEPTION 'Migration 019: every reviewer needs a programme to be moved. Without one: %',
            (SELECT string_agg(email, ', ') FROM users WHERE role = 'reviewer' AND programme_id IS NULL);
    END IF;
END $$;

-- ---------- 1. staff_programmes ----------
CREATE TABLE staff_programmes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    can_assist BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ended_at TIMESTAMPTZ,
    CONSTRAINT staff_programmes_role_known CHECK (role IN ('main', 'extra')),
    CONSTRAINT staff_programmes_assist_only_extra CHECK (role = 'extra' OR can_assist = false),
    CONSTRAINT staff_programmes_ended_after_start CHECK (ended_at IS NULL OR ended_at >= created_at)
);

-- At most one current main reviewer per programme
CREATE UNIQUE INDEX staff_programmes_one_main ON staff_programmes (programme_id) WHERE role = 'main' AND ended_at IS NULL;
-- One current link per person and programme (a role change ends the old link and starts a new one)
CREATE UNIQUE INDEX staff_programmes_one_current_link ON staff_programmes (user_id, programme_id) WHERE ended_at IS NULL;
CREATE INDEX staff_programmes_user_id_idx ON staff_programmes (user_id);

COMMENT ON TABLE staff_programmes IS 'Which staff work on which programme, and how: main (sees and decides everything; one per programme) or extra (sees the programme only while can_assist is on). ended_at set = the link has ended; the row stays for history.';
COMMENT ON COLUMN staff_programmes.can_assist IS 'Extra reviewers only: while true they see and decide the programme''s applications; while false (standby) they see nothing of it.';
COMMENT ON COLUMN staff_programmes.ended_at IS 'When the link ended (removed from the programme, swapped, or the account deactivated). NULL = current.';

-- Reviewers -> main links. A deactivated reviewer's link ended when they were deactivated
-- (never before it started: created_at is the account's creation, at the latest the deactivation).
INSERT INTO staff_programmes (user_id, programme_id, role, created_at, ended_at)
SELECT id, programme_id, 'main', LEAST(COALESCE(created_at, now()), COALESCE(deactivated_at, now())), deactivated_at
FROM users WHERE role = 'reviewer';

DO $$
DECLARE
    reviewers integer; links integer; current_links integer; active_reviewers integer;
BEGIN
    SELECT count(*) INTO reviewers FROM users WHERE role = 'reviewer';
    SELECT count(*) FILTER (WHERE deactivated_at IS NULL) INTO active_reviewers FROM users WHERE role = 'reviewer';
    SELECT count(*), count(*) FILTER (WHERE ended_at IS NULL) INTO links, current_links FROM staff_programmes;
    IF links <> reviewers OR current_links <> active_reviewers THEN
        RAISE EXCEPTION 'Migration 019: % reviewer(s) (% active) but % link(s) (% current)', reviewers, active_reviewers, links, current_links;
    END IF;
    IF EXISTS (SELECT 1 FROM staff_programmes s JOIN users u ON u.id = s.user_id WHERE s.programme_id <> u.programme_id) THEN
        RAISE EXCEPTION 'Migration 019: a link has another programme than its reviewer';
    END IF;
    RAISE NOTICE 'Migration 019: % reviewer(s) linked as main reviewer (% current, % ended).', links, current_links, links - current_links;
END $$;

-- users.programme_id: students only from now on
ALTER TABLE users DROP CONSTRAINT users_reviewers_have_programme;
DROP INDEX users_one_active_reviewer_per_programme;
UPDATE users SET programme_id = NULL WHERE role = 'reviewer';
ALTER TABLE users ADD CONSTRAINT users_programme_only_students CHECK (role = 'student' OR programme_id IS NULL);
COMMENT ON COLUMN users.programme_id IS 'A student''s study programme. Staff have none here: their programmes are in staff_programmes.';

-- ---------- 2. open applications: shared ----------
DO $$
DECLARE
    open_assigned integer; cleared integer; decided_before integer; decided_after integer;
BEGIN
    SELECT count(*) INTO open_assigned FROM applications WHERE status IN ('pending', 'needs_info') AND assigned_reviewer_id IS NOT NULL;
    SELECT count(*) INTO decided_before FROM applications WHERE status NOT IN ('pending', 'needs_info') AND assigned_reviewer_id IS NOT NULL;
    UPDATE applications SET assigned_reviewer_id = NULL WHERE status IN ('pending', 'needs_info') AND assigned_reviewer_id IS NOT NULL;
    GET DIAGNOSTICS cleared = ROW_COUNT;
    SELECT count(*) INTO decided_after FROM applications WHERE status NOT IN ('pending', 'needs_info') AND assigned_reviewer_id IS NOT NULL;
    IF cleared <> open_assigned OR decided_after <> decided_before THEN
        RAISE EXCEPTION 'Migration 019: % open assigned, % made shared; decided assigned % before, % after', open_assigned, cleared, decided_before, decided_after;
    END IF;
    RAISE NOTICE 'Migration 019: % open application(s) made shared; % decided one(s) unchanged.', cleared, decided_after;
END $$;

COMMENT ON COLUMN applications.assigned_reviewer_id IS 'The reviewer the admin assigned this application to; NULL = shared (everyone who can see the programme may take it).';

-- ---------- 3. staff invites: programme(s) and role in each ----------
CREATE TABLE staff_invite_programmes (
    invite_id INTEGER NOT NULL REFERENCES staff_invites(id) ON DELETE CASCADE,
    programme_id INTEGER NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    replace_main BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (invite_id, programme_id),
    CONSTRAINT staff_invite_programmes_role_known CHECK (role IN ('main', 'extra')),
    CONSTRAINT staff_invite_programmes_replace_only_main CHECK (role = 'main' OR replace_main = false)
);
CREATE INDEX staff_invite_programmes_programme_id_idx ON staff_invite_programmes (programme_id);

COMMENT ON TABLE staff_invite_programmes IS 'The programmes a reviewer invite is for, and the role in each. replace_main: when accepted, the programme''s current main reviewer is swapped out (main only; an extra never replaces anyone).';

INSERT INTO staff_invite_programmes (invite_id, programme_id, role, replace_main)
SELECT id, programme_id, 'main', replace_reviewer FROM staff_invites WHERE programme_id IS NOT NULL;

DO $$
DECLARE
    invites integer; rows_moved integer;
BEGIN
    SELECT count(*) INTO invites FROM staff_invites WHERE programme_id IS NOT NULL;
    SELECT count(*) INTO rows_moved FROM staff_invite_programmes p JOIN staff_invites i ON i.id = p.invite_id
        WHERE p.programme_id = i.programme_id AND p.replace_main = i.replace_reviewer;
    IF rows_moved <> invites THEN
        RAISE EXCEPTION 'Migration 019: % reviewer invite(s) but % moved', invites, rows_moved;
    END IF;
    RAISE NOTICE 'Migration 019: % reviewer invite(s) moved to staff_invite_programmes.', rows_moved;
END $$;

ALTER TABLE staff_invites
    DROP CONSTRAINT staff_invites_programme_for_reviewers,
    DROP CONSTRAINT staff_invites_replace_only_reviewers,
    DROP COLUMN programme_id,
    DROP COLUMN replace_reviewer;
COMMENT ON TABLE staff_invites IS 'Invitations for reviewers (programmes in staff_invite_programmes) and admins, sent by the superadmin. Valid 7 days, single use; the link token is stored hashed. Status is worked out when read: accepted / cancelled / expired / sent.';
