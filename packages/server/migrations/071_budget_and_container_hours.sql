-------------------------------------------------------------------------------
-- Budgets: the token split behind a run's cost, container-hour metering, and
-- uncapped agents by default
-------------------------------------------------------------------------------
--
-- Three changes, one file. They ship together and are meaningless apart: the
-- first two are what the Budget page's two tabs read from, and the third is the
-- default those tabs render against.
--
-- 1. THE TOKEN SPLIT BEHIND A COST
--
-- Every runtime reports its cache buckets and `agent-stream-parser.ts` already
-- prices all four, but `AgentRunUsage` collapsed them to one `inputTokens` sum
-- one line later, so the split reached nothing. That made a recorded cost
-- unauditable: there was no way, after the fact, to see whether a figure came
-- from fresh input or from cache reads at a tenth of the rate.
--
-- Nullable with no backfill, and NULL is the honest value rather than a gap -
-- the same reasoning 065 records for `created_by_run_id` and 066 for
-- `cancel_reason`. The split did not exist before, so no historical row has one,
-- and no SQL can recover it from the sum that was kept.
--
-- `input_tokens` KEEPS ITS MEANING: total input, INCLUDING both cache buckets.
-- Changing it to the uncached remainder would silently redefine every existing
-- row and every reader. The uncached figure is `input_tokens` less the two
-- columns below. Note this is the opposite convention to `CostTokens.inputTokens`
-- in `@hezo/shared`, which is uncached-only; both are commented at their
-- definitions.
--
-- No index. Neither column is filtered or sorted on - they are projected onto a
-- run the reader already named.

ALTER TABLE heartbeat_runs
    ADD COLUMN IF NOT EXISTS cache_read_tokens     BIGINT,
    ADD COLUMN IF NOT EXISTS cache_creation_tokens BIGINT;

-------------------------------------------------------------------------------
-- 2. CONTAINER-HOUR METERING
--
-- Nothing measured container uptime. The Activity page's "Hours" is per-agent
-- run wall-clock, which is a different quantity and wrong in both directions for
-- billing: it sums concurrent runs that shared one container, and it cannot see
-- build time, warm-idle time, or the assistant chat's container at all.
--
-- A row is ONE RUNNING STRETCH, not one container lifetime. A managed backend
-- bills a started sandbox for vCPU + RAM + disk and a stopped one for reserved
-- disk only, so compute billing ends at stop and a container that suspends and
-- resumes three times is four rows. The interval opens when provisioning starts
-- rather than when the container is ready, because the build - image resolve,
-- clone, package install - is the longest phase on a managed backend and is
-- billed like any other running minute.
--
-- `project_id` is ON DELETE SET NULL, mirroring `cost_entries`: the hours were
-- billed whether or not the project still exists, and discarding the operator's
-- cost history is never a default. `container_id` is deliberately un-FK'd, for
-- the same reason `heartbeat_runs.container_id` is - the row must outlive the
-- container it describes.
--
-- `memory_bytes` / `disk_ceiling_bytes` are recorded even where a deployment
-- fixes the container shape: a self-hoster varies the instance-wide RAM cap and
-- may override it per project, so "fixed" is a policy, not an invariant, and a
-- shape-blind hour cannot be re-costed later.

CREATE TABLE IF NOT EXISTS container_uptime_entries (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id         UUID REFERENCES projects(id) ON DELETE SET NULL,
    container_id       TEXT NOT NULL,
    started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at           TIMESTAMPTZ,
    -- stopped | suspended | destroyed | reconciled. TEXT rather than an enum,
    -- matching `cancel_reason` and `queued_reason`: the value set lives in
    -- `@hezo/shared` and is read through a guard, so a value written by a newer
    -- server degrades on an older client rather than crashing it. TEXT also
    -- avoids `ALTER TYPE ... ADD VALUE`, which cannot have its new value used in
    -- the same transaction a migration runs in.
    end_reason         TEXT,
    memory_bytes       BIGINT,
    disk_ceiling_bytes BIGINT,
    -- The assistant chat's container is metered like any other - it is billed
    -- like any other - but flagged so it can be reported separately.
    reserved_for_chat  BOOLEAN NOT NULL DEFAULT false,
    backend            TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one open interval per container. This is what makes open and close
-- idempotent on every path that reaches them, and there are many: the
-- running-to-stopped sync branch, the memory-limit auto-stop, the acquire
-- ladder's gone-versus-stopped distinction, both retirement planners, and
-- teardown. Without it a double-close would silently open a second interval and
-- bill the same minutes twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_container_uptime_open
    ON container_uptime_entries (container_id) WHERE ended_at IS NULL;

-- The per-project windowed aggregation: this project's intervals, by time.
CREATE INDEX IF NOT EXISTS idx_container_uptime_project
    ON container_uptime_entries (project_id, started_at);

-- The instance-scoped one, which has no project predicate to lead on.
CREATE INDEX IF NOT EXISTS idx_container_uptime_started
    ON container_uptime_entries (started_at);

-------------------------------------------------------------------------------
-- 3. AGENTS SHIP UNCAPPED
--
-- The $30/month default was arbitrary, and until the cache rates landed it bit
-- several times sooner than its face value read, so a team could stop for a
-- reason its operator never chose. Projects have defaulted to 0 (unlimited)
-- since the baseline schema; this brings agents into line.
--
-- SET DEFAULT DOES NOT TOUCH EXISTING ROWS. An upgrading instance keeps every
-- cap it configured - that is the whole point of doing it this way rather than
-- with an UPDATE, and the data-preservation test asserts it.

ALTER TABLE agent_types   ALTER COLUMN monthly_budget_cents SET DEFAULT 0;
ALTER TABLE member_agents ALTER COLUMN monthly_budget_cents SET DEFAULT 0;
