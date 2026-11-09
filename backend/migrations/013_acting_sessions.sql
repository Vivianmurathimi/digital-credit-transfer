-- 013: the admin acting as a student or reviewer (admin round, Group 1).
--
-- The superadmin can act as any student or active reviewer and do anything they can do. Each time
-- is one row here: started when the admin starts acting, ended by Exit. The acting token carries
-- this row's id, and verifyToken refuses the token from the moment ended_at is set, so Exit really
-- ends the session on the server too.
--
-- What the admin does while acting is recorded as 'admin' with the admin's id (application_events,
-- decided_by / decided_by_role), never as the person they act as.

CREATE TABLE acting_sessions (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    person_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    person_role VARCHAR(20) NOT NULL CHECK (person_role IN ('student', 'reviewer')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    CONSTRAINT acting_sessions_not_self CHECK (admin_id <> person_id),
    CONSTRAINT acting_sessions_ends_after_start CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX acting_sessions_admin_idx ON acting_sessions (admin_id, started_at DESC);
CREATE INDEX acting_sessions_person_idx ON acting_sessions (person_id);

COMMENT ON TABLE acting_sessions IS 'Each time the superadmin acted as a student or reviewer: who, as whom, from when until when (ended_at NULL while it lasts).';
