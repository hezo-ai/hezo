-- Three schema changes behind one set of agent-run health fixes. Siblings from
-- one change set, so they share a file rather than stacking numbers.
--
-- All three are additive. No row is read, moved, dropped or rewritten.

-------------------------------------------------------------------------------
-- 1. Reading a thread without its run rows
-------------------------------------------------------------------------------
--
-- `list_comments` now returns the conversation and the task's own events by
-- default, leaving out the one-row-per-execution `run` markers. On a task that
-- has been open for months those markers are the bulk of the thread and carry
-- nothing the thread itself does not - a run's status, exit code and log are
-- served by `list_task_runs` and `get_run_log` in a form worth reading.
--
-- Partial rather than composite. `(task_id, content_type, created_at)` cannot
-- return rows in `created_at` order while `content_type` sits between the two,
-- so every page would need a sort. Matching the default predicate exactly lets
-- the same read come back as one ordered scan.
--
-- Spelled `<>` rather than as a list of every type except `run`, so a content
-- type added later stays covered. A list would stop covering the default query
-- the moment the enum grew, and the symptom would be a lost index rather than
-- an error.
--
-- `id` is in the key because the keyset cursor compares `(created_at, id)` as a
-- tuple; without it the second half of every cursor comparison is a filter. The
-- existing `idx_comments_task_created` stays - it serves the unfiltered read the
-- web app makes, and the no-work backoff's `created_at` probe.

CREATE INDEX IF NOT EXISTS idx_comments_task_created_no_run
    ON task_comments (task_id, created_at DESC, id DESC)
    WHERE content_type <> 'run'::comment_content_type;

-------------------------------------------------------------------------------
-- 2. Attributing a wakeup to the run whose write caused it
-------------------------------------------------------------------------------
--
-- The no-wake exit check asks whether an execution ended having notified anyone
-- it named. It could only answer from the run's own comments - an active
-- `@`-mention, or a reply - because a wakeup recorded nothing about who caused
-- it. Every wake the server wires structurally was invisible: an assignment on a
-- new task, a reassignment, a blocker release the cascade fires. So a run that
-- routed work correctly and then referred to the recipient passively - which is
-- what the shared instructions ask for - was reported as stranding a handoff.
--
-- Nullable with no backfill, and NULL is the honest value rather than a gap: the
-- attribution did not exist before, which is precisely the state every existing
-- row is in. It stays the correct value for every wakeup no run causes - a
-- heartbeat, a timer, an operator pressing Run now, a container or orphan sweep.
--
-- The FK pairs with `heartbeat_runs.wakeup_id` pointing the other way. Both are
-- nullable so neither constrains insert order, and the two edges cannot collide:
-- the wakeup that drove a run is never one that run created.
--
-- Partial index, mirroring `idx_tasks_created_by_run`. The overwhelming majority
-- of rows are NULL and the only query on this column names a run.

ALTER TABLE agent_wakeup_requests
    ADD COLUMN IF NOT EXISTS created_by_run_id UUID
        REFERENCES heartbeat_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wakeups_created_by_run
    ON agent_wakeup_requests (created_by_run_id)
    WHERE created_by_run_id IS NOT NULL;

-------------------------------------------------------------------------------
-- 3. Positive evidence that an MCP server answers without a credential
-------------------------------------------------------------------------------
--
-- A hosted MCP with neither an OAuth connection nor a stored API key was handed
-- to every run on the assumption it was public, unless one of three markers
-- guessed otherwise. A row none of them caught failed its handshake inside the
-- container, where nothing on this side could see it, and was handed over again
-- on the next run - forever. The connector health sweep could not help: it reads
-- `oauth_connections`, so a row with no connection is invisible to it.
--
-- These two columns replace all three guesses with one measurement:
--   probed_at    the last probe attempt of any outcome, and the pacing clock
--   probe_error  why that attempt failed; NULL when it succeeded
-- so "may reach a run" becomes `probed_at IS NOT NULL AND probe_error IS NULL`.
--
-- The evidence is the MCP handshake, not the tool catalog. A server that serves
-- only prompts or resources answers `initialize` and refuses `tools/list`, so
-- gating on `methods_listed_at` would exclude a class of perfectly public
-- servers.
--
-- An enum rather than free text because this value is shown to operators and
-- returned to agents. A probe failure's underlying message quotes the upstream
-- body, and an upstream that echoes the request headers back would put a live
-- credential in a column. A closed set cannot carry one; the full detail stays
-- in the server log.
--
-- Deliberately NOT backfilled. No SQL can probe a third-party server, and
-- stamping existing rows would assert the very evidence this requires -
-- preserving the bug for exactly the rows that have it. Existing uncredentialed
-- rows start unproven and are re-proven by the health sweep, oldest first.

CREATE TYPE connector_probe_error AS ENUM ('auth_required', 'unreachable');

ALTER TABLE mcp_connections
    ADD COLUMN IF NOT EXISTS probed_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS probe_error connector_probe_error;

-- The health sweep asks for the uncredentialed hosted connectors whose probe is
-- oldest, never-probed first. Partial over exactly that candidate set, so a
-- credentialed or non-hosted row never enters the index. `NULLS FIRST` is
-- declared because the query orders that way and ASC defaults to NULLS LAST,
-- which would not match.

CREATE INDEX IF NOT EXISTS idx_mcp_connections_probe_due
    ON mcp_connections (probed_at NULLS FIRST)
    WHERE kind = 'saas'
      AND revoked_at IS NULL
      AND oauth_connection_id IS NULL
      AND api_key_secret_id IS NULL;
