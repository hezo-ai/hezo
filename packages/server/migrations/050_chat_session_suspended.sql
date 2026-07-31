-- A chat session survives its container being suspended.
--
-- The CEO chat is pinned to one container and every turn execs against it, but
-- the session holds **no long-lived process**: each turn is its own exec, and
-- continuity comes from `chat_conversations` / `chat_messages` in the database.
-- So a container that stops without losing its filesystem takes nothing with it
-- that the session needs - which is exactly what suspend is.
--
-- Until now the health check tore the session down whenever the project's
-- container stopped, because a Docker stop is indistinguishable from a container
-- that has gone. A managed sandbox backend suspends on its own idle timer, so
-- without this every idle period would end the operator's chat session and drop
-- its in-memory allocations, and the next message would pay a cold start.
--
-- `suspended` is the resting state between those: the row stays live, the
-- container is stopped but intact, and the next turn resumes it and re-runs the
-- host-side half of session start (the ssh socket and egress proxy allocation,
-- whose ports do not survive).

-- Purely additive enum extension. Postgres 12+ (PGlite is PG16) permits
-- ALTER TYPE ... ADD VALUE inside a transaction as long as the new value is not
-- *used* in the same transaction - this migration only adds it and rewrites an
-- index predicate that names existing values (pattern: 027, 038).
ALTER TYPE chat_session_status ADD VALUE IF NOT EXISTS 'suspended';

-- The singleton guard must count a suspended session as live: it still owns its
-- session row and its container, so a second one starting alongside it would
-- give the operator two chat sessions racing the same container.
--
-- Stated as "not terminal" rather than by listing the live values, so it names
-- only pre-existing enum values (required - the new one cannot be used in this
-- transaction) and so any future live status is covered by default. Defaulting a
-- new status to "counts as live" is the safe direction for a uniqueness guard.
DROP INDEX idx_chat_sessions_singleton;
CREATE UNIQUE INDEX idx_chat_sessions_singleton
    ON chat_sessions(member_id)
    WHERE status NOT IN ('crashed', 'stopped');
