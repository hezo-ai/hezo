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
    -- What became of this container: the error that ended it, and the last
    -- output it produced. Both used to live on `projects` (one column each) and
    -- had to move here for the same reason the table exists: a project now holds
    -- several containers, so a single column could only describe whichever one
    -- stopped last, and attributed its account to all of them.
    last_error           TEXT,
    last_logs            TEXT,
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
INSERT INTO container_pool_members
    (project_id, container_id, state, last_error, last_logs, last_started_at)
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
    -- Matched by construction: this row IS the container `projects.container_id`
    -- named, which is exactly what that column's logs described.
    p.container_last_logs,
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

-- Which container a run executed in.
--
-- The pool's entire purpose is that one run can no longer take down its
-- siblings, and that was not achievable while a run recorded only its task: the
-- container-death path (`failProjectRuns`) could scope the blast radius no
-- narrower than the project, so a single container's OOM or crash still failed
-- every run in it - including runs sitting healthy in their own containers. The
-- attribution is what lets that path fail exactly the runs that were actually on
-- the dead container.
--
-- Nullable and unbacked by a foreign key on purpose. It is a *historical* record
-- of where a run executed, so it must survive the container being destroyed -
-- which, with suspend-and-destroy, is the normal end of a container's life
-- rather than an exception. Rows that predate this column stay NULL, and the
-- death path treats NULL as "cannot attribute" and falls back to the old
-- project-wide behaviour for them, which is the safe direction: an unattributable
-- run is failed rather than left running against a container that is gone.
ALTER TABLE heartbeat_runs ADD COLUMN container_id TEXT;

-- The death path asks "which live runs were on this container", so the index
-- serves that predicate directly. Partial on the running rows: finished runs are
-- the overwhelming majority and are never what this asks about.
CREATE INDEX idx_runs_container_live ON heartbeat_runs (container_id)
    WHERE status = 'running' AND container_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Capacity: a memory budget instead of a container count.
-- ---------------------------------------------------------------------------

-- Capacity becomes a memory budget instead of a container count.
--
-- `max_active_containers` bounded memory only while every container was the
-- same size, and `projects.memory_limit_gib` exists precisely so they are not:
-- a project raising its cap to 4 GB took one "slot" but twice the memory of the
-- 2 GB containers the instance was sized for, silently oversubscribing the host
-- (and, on a managed backend, silently doubling the bill for the same count).
--
-- Summing what each running container actually asked for makes the cap mean one
-- thing regardless of overrides. It also removes a setting rather than adding
-- one: how many containers fit now falls out of the budget and the per-container
-- cap, so there is nothing left for an operator to keep consistent by hand.
--
-- The trade-off is that a large container waits for enough budget rather than
-- for any free slot. That is a delay, not starvation, because a cap larger than
-- the whole budget is refused where it is set (see `projectMemoryFitsBudget`)
-- rather than queued forever.

-- Carry an explicit choice forward rather than dropping the operator's intent:
-- N containers at the effective per-container cap is N x cap GB. Only an
-- explicitly-set value is converted - an instance that never set one keeps
-- getting the computed default, which is now computed in GB.
INSERT INTO system_meta (key, value)
SELECT
    'max_container_memory_gb',
    (
        (SELECT value::int FROM system_meta WHERE key = 'max_active_containers')
        * COALESCE(
            (SELECT value::int FROM system_meta WHERE key = 'default_ram_cap_per_container_gb'),
            2
        )
    )::text
WHERE EXISTS (SELECT 1 FROM system_meta WHERE key = 'max_active_containers')
  AND NOT EXISTS (SELECT 1 FROM system_meta WHERE key = 'max_container_memory_gb')
ON CONFLICT (key) DO NOTHING;

-- The old key is read by nothing after this. Removing it is what stops a stale
-- number sitting in the settings table looking authoritative.
DELETE FROM system_meta WHERE key = 'max_active_containers';

-- The container idle window stops being an operator setting too.
--
-- Its only real job is coalescing a burst - covering the gap between one run
-- finishing and the next starting in the same project, so the next run finds a
-- warm container rather than resuming or creating one. That gap is seconds to
-- about a minute, and an operator has no way to reason about it better than the
-- system can, so it is now the `CONTAINER_IDLE_TIMEOUT_MIN` constant.
--
-- Nothing is carried forward: there is no new key for the value to move to, and
-- a stored number that nothing reads is worse than no row at all - it sits in
-- the settings table looking authoritative. The `0 = never stop` escape hatch
-- goes with it, deliberately: a container that never stops bills forever on a
-- managed backend, and the dev server it used to keep alive belongs in
-- something with its own lifecycle.
DELETE FROM system_meta WHERE key = 'container_idle_timeout_min';

-- ---------------------------------------------------------------------------
-- Container disk becomes a setting, and the recycle threshold a per-member fact.
-- ---------------------------------------------------------------------------

-- Container disk becomes a setting, and the pool's recycle threshold becomes a
-- property of each container rather than a constant.
--
-- Disk was fixed at whatever the adapter hardcoded (10 GB on Daytona) and the
-- pool recycled a member at a flat 2 GB. That pairing only makes sense for one
-- allocation size: on a provider whose account-wide disk quota is what binds
-- first, 10 GB per sandbox buys headroom nobody uses and costs slots everybody
-- wants, and a 2 GB recycle threshold against it churns containers with 8 GB
-- free. So the allocation becomes an instance default with a per-project
-- override - the same shape as the per-container RAM cap, which projects already
-- override the same way - and the threshold is derived from it.
--
-- The threshold is stored per member rather than computed at read time on
-- purpose: a container keeps the ceiling matching the disk it was actually
-- created with. Raising the default afterwards must not tell a container that was
-- given the old allocation that it may fill to the new one, because it really does
-- only have what it was created with and the run that discovered otherwise would
-- fail partway through.

-- NULL means "inherit the instance default", exactly like memory_limit_gib.
ALTER TABLE projects ADD COLUMN container_disk_gb INTEGER;

ALTER TABLE projects ADD CONSTRAINT projects_container_disk_gb_positive
    CHECK (container_disk_gb IS NULL OR container_disk_gb >= 2);

-- Existing members keep the flat 2 GB they were provisioned and judged against.
-- Backfilling them to a threshold derived from the *new* default would change
-- the recycle behaviour of containers that already exist, which is the one thing
-- this migration must not do.
ALTER TABLE container_pool_members
    ADD COLUMN disk_ceiling_bytes BIGINT NOT NULL DEFAULT 2147483648;

-- ---------------------------------------------------------------------------
-- The memory a container was provisioned to cover, recorded per member.
-- ---------------------------------------------------------------------------

-- The same fact as `disk_ceiling_bytes` above, for the resource that had no
-- equivalent: what the container was actually built to hold, as distinct from
-- what the setting says today.
--
-- Without it the cap is a number the pool asserts and can never check. Raising a
-- project's cap left its existing container in service at the old allocation,
-- and every consumer - the run's sizing, the instance memory budget, the
-- enforcement threshold, the exit-137 message and the Containers page - read the
-- new figure against a container that did not have it. The container really is
-- only as big as it was created, and no backend can resize one in place, so the
-- only correct response is to replace it.
--
-- NULL means "unknown", and is deliberately not backfilled. Existing members
-- were provisioned against whatever the cap happened to be at the time, and
-- there is no record of it; deriving one from the current cap would write a
-- confident wrong answer for exactly the containers this exists to catch.
-- Unknown reads as "cannot prove it covers the cap", so each pre-existing member
-- is recycled once, on the next run that would otherwise have reused it.
ALTER TABLE container_pool_members
    ADD COLUMN memory_bytes BIGINT;
