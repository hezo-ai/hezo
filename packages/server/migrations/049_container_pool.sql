-- Container pool: a project gets as many containers as it has concurrent runs,
-- bounded by capacity, instead of exactly one.
--
-- The reason is blast radius. Today every run in a project shares one container
-- and therefore one memory cap, so exceeding it stops the container and fails
-- *every* run in that project - one greedy run takes down its siblings. A
-- container that serves at most one run at a time removes that entirely.
--
-- Deliberately ADDITIVE. `projects.container_id` and its siblings stay, and
-- every existing row is carried forward as a single-member pool, so an instance
-- that upgrades keeps behaving exactly as it did while the call sites move over
-- one at a time. Dropping those columns is a later migration, once nothing
-- reads them - doing it here would mean a schema change and a rewrite of the
-- container lifecycle landing together, which is not a change anyone could
-- review.

CREATE TYPE container_pool_state AS ENUM ('creating', 'idle', 'busy', 'suspended', 'error');

CREATE TABLE container_pool_members (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- The engine's own id: a Docker container id, or a provider sandbox id.
    container_id         TEXT NOT NULL,
    state                container_pool_state NOT NULL DEFAULT 'creating',
    -- Affinity: the task this container last served. Its worktree and
    -- node_modules are already built, which is why reusing it is the common
    -- case rather than an optimization.
    last_task_id         UUID,
    -- Disk is the constraint that does not exist today: /workspace is a bind
    -- mount with the operator's whole disk behind it, while a provider sandbox
    -- gets a few GB total. A member at its ceiling is recycled, not reused.
    disk_used_bytes      BIGINT NOT NULL DEFAULT 0,
    -- Set while this container holds commits that reached neither origin nor
    -- the mirror. Such a member is pinned against both suspend and destroy: the
    -- work exists nowhere else and nothing downstream would report it gone.
    has_unpushed_commits BOOLEAN NOT NULL DEFAULT false,
    -- The CEO chat's pinned container. A task run may never take it - a queued
    -- task run is invisible and harmless, a queued chat turn is a person
    -- watching a spinner.
    reserved_for_chat    BOOLEAN NOT NULL DEFAULT false,
    last_error           TEXT,
    last_started_at      TIMESTAMPTZ,
    last_released_at     TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One row per engine container, so a double-insert cannot produce two
    -- members that both believe they own it.
    UNIQUE (container_id)
);

-- Serves the per-project selection query (members of this project, by state),
-- which runs on every container acquire.
CREATE INDEX idx_container_pool_members_project
    ON container_pool_members (project_id, state);

-- Serves the capacity check, which counts containers running instance-wide.
-- Partial, because suspended and errored members cost storage rather than
-- capacity and never consume a slot.
CREATE INDEX idx_container_pool_members_running
    ON container_pool_members (state)
    WHERE state IN ('creating', 'idle', 'busy');

-- Carry every existing project's container forward as a single-member pool.
--
-- `running` maps to `idle` rather than `busy` on purpose: boot already fails
-- every in-flight run and never reattaches, so by the time this has applied
-- nothing is genuinely serving a run. `stopping` maps to `suspended` for the
-- same reason - it is transitional, and the resting state it is heading for is
-- the one that matters.
INSERT INTO container_pool_members (project_id, container_id, state, last_error, last_started_at)
SELECT
    p.id,
    p.container_id,
    CASE p.container_status
        WHEN 'creating' THEN 'creating'::container_pool_state
        WHEN 'running'  THEN 'idle'::container_pool_state
        WHEN 'stopping' THEN 'suspended'::container_pool_state
        WHEN 'stopped'  THEN 'suspended'::container_pool_state
        WHEN 'error'    THEN 'error'::container_pool_state
        ELSE 'idle'::container_pool_state
    END,
    p.container_error,
    p.container_last_started_at
FROM projects p
WHERE p.container_id IS NOT NULL
ON CONFLICT (container_id) DO NOTHING;

-- ---------------------------------------------------------------------------
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
