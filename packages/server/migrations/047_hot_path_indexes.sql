-- Indexes for queries that run on a cron or on nearly every request, and had
-- nothing to serve them. Each one is paired with the query it exists for; an
-- index nobody's predicate can use is not an index.
--
-- 1. `heartbeat_runs (member_id, finished_at DESC)`
--    The scheduled-heartbeat scan (`processScheduledHeartbeats`) runs every 5
--    seconds and carries a correlated
--    `NOT EXISTS (... WHERE hr.member_id = ma.id AND hr.finished_at > now() - interval)`
--    per candidate agent. Only `idx_runs_member(member_id)` existed, so the
--    recency test degraded as an agent accumulated runs - and runs are never
--    pruned.
--
-- 2. `heartbeat_runs (member_id, started_at DESC)`
--    The agent executions list is `WHERE member_id = $1 ORDER BY started_at DESC
--    LIMIT/OFFSET`. Filter-then-sort-then-limit wants the composite in that
--    order; a `member_id`-only index still had to sort every run the agent has
--    ever done to render one page.
--
-- 3. `heartbeat_runs (task_id, started_at DESC)`
--    `WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1` - a task's latest run,
--    read by the task view and by the runner's own continuation check.
--
-- 4. `agent_wakeup_requests (status, created_at)`
--    The dispatcher scans `status = 'queued' AND created_at < $1 ORDER BY
--    created_at ASC LIMIT 10` every 5 seconds. `idx_wakeups_status` is a plain
--    btree on a low-cardinality enum, so this was an index scan plus a sort over
--    every queued row. Partial on the two live states: terminal rows are the
--    overwhelming majority and the dispatcher never looks at them, so keeping
--    them out holds the index to the working set.
--
-- 5. `tasks (team_id, LOWER(identifier))`
--    `resolveTaskId` compares `LOWER(identifier) = LOWER($2)` and so cannot use
--    `idx_tasks_identifier(team_id, identifier)`. It runs at the top of
--    essentially every task and comment request.
--
-- All five are additive; no data is read, moved or dropped.

CREATE INDEX IF NOT EXISTS idx_runs_member_finished
    ON heartbeat_runs (member_id, finished_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_member_started
    ON heartbeat_runs (member_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_task_started
    ON heartbeat_runs (task_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_wakeups_pending
    ON agent_wakeup_requests (status, created_at)
    WHERE status IN ('queued', 'claimed');

CREATE INDEX IF NOT EXISTS idx_tasks_identifier_lower
    ON tasks (team_id, LOWER(identifier));
