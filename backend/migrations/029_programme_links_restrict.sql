-- 029: the database protects programmes from cascading deletes (DB cleanup 2). One transaction.
--
-- Until now deleting a programme silently took its staff links, invite lines, other codes and
-- email-reminder records with it (ON DELETE CASCADE). Now the database refuses (ON DELETE RESTRICT):
-- the programme delete route removes what may go explicitly (its aliases, reminder records and
-- unused courses), and only after its "in use" check passed. Nothing is copied or deleted here.
--
--   staff_programmes.programme_id          CASCADE -> RESTRICT
--   staff_invite_programmes.programme_id   CASCADE -> RESTRICT
--   programme_aliases.programme_id         CASCADE -> RESTRICT
--   reviewer_reminders.programme_id        CASCADE -> RESTRICT
--   committee_reminders.programme_id       CASCADE -> RESTRICT
-- Unchanged (they already refuse): users, courses, applications (NO ACTION), student_programme_changes (RESTRICT).

CREATE TEMP TABLE m029_counts ON COMMIT DROP AS
SELECT (SELECT count(*) FROM staff_programmes) AS staff, (SELECT count(*) FROM staff_invite_programmes) AS invites,
       (SELECT count(*) FROM programme_aliases) AS aliases, (SELECT count(*) FROM reviewer_reminders) AS reviewer_reminders,
       (SELECT count(*) FROM committee_reminders) AS committee_reminders, (SELECT count(*) FROM programmes) AS programmes;

ALTER TABLE staff_programmes DROP CONSTRAINT staff_programmes_programme_id_fkey,
    ADD CONSTRAINT staff_programmes_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE RESTRICT;
ALTER TABLE staff_invite_programmes DROP CONSTRAINT staff_invite_programmes_programme_id_fkey,
    ADD CONSTRAINT staff_invite_programmes_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE RESTRICT;
ALTER TABLE programme_aliases DROP CONSTRAINT programme_aliases_programme_id_fkey,
    ADD CONSTRAINT programme_aliases_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE RESTRICT;
ALTER TABLE reviewer_reminders DROP CONSTRAINT reviewer_reminders_programme_id_fkey,
    ADD CONSTRAINT reviewer_reminders_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE RESTRICT;
ALTER TABLE committee_reminders DROP CONSTRAINT committee_reminders_programme_id_fkey,
    ADD CONSTRAINT committee_reminders_programme_id_fkey FOREIGN KEY (programme_id) REFERENCES programmes(id) ON DELETE RESTRICT;

DO $$
DECLARE
    before record; cascading text; restricted integer;
BEGIN
    SELECT * INTO before FROM m029_counts;
    IF before.staff <> (SELECT count(*) FROM staff_programmes) OR before.invites <> (SELECT count(*) FROM staff_invite_programmes)
       OR before.aliases <> (SELECT count(*) FROM programme_aliases) OR before.reviewer_reminders <> (SELECT count(*) FROM reviewer_reminders)
       OR before.committee_reminders <> (SELECT count(*) FROM committee_reminders) OR before.programmes <> (SELECT count(*) FROM programmes) THEN
        RAISE EXCEPTION 'Migration 029: a row count changed';
    END IF;
    -- No foreign key to programmes deletes along with it any more
    SELECT string_agg(conname, ', ') INTO cascading FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'programmes'::regclass AND confdeltype = 'c';
    IF cascading IS NOT NULL THEN
        RAISE EXCEPTION 'Migration 029: still deleting along with a programme: %', cascading;
    END IF;
    SELECT count(*) INTO restricted FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'programmes'::regclass AND confdeltype = 'r'
          AND conname IN ('staff_programmes_programme_id_fkey', 'staff_invite_programmes_programme_id_fkey', 'programme_aliases_programme_id_fkey',
                          'reviewer_reminders_programme_id_fkey', 'committee_reminders_programme_id_fkey');
    IF restricted <> 5 THEN
        RAISE EXCEPTION 'Migration 029: expected 5 restricting links, found %', restricted;
    END IF;
    RAISE NOTICE 'Migration 029: 5 links to programmes now refuse a delete (% staff links, % invite lines, % aliases, % + % reminder records kept).',
        before.staff, before.invites, before.aliases, before.reviewer_reminders, before.committee_reminders;
END $$;
