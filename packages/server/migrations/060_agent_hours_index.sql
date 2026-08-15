-- Index for the Activity page's Hours tab, which sums per-agent wall-clock run
-- time for a project.
--
-- `heartbeat_runs (team_id, started_at)`
--    Every query behind the tab is `WHERE team_id = $1 AND started_at >= <window>`
--    grouped by agent, over a table that is never pruned. The nearest existing
--    index, `idx_runs_team_started_task` (049), is partial on
--    `WHERE task_id IS NOT NULL` - it exists to keep the Progress page from
--    reporting on the Captain's own progress-update runs. Hours counts every run
--    an agent spent on the project, task-scoped or not, so that partial index
--    cannot serve it and the read degrades to a scan of the whole team's history.
--    Ascending rather than DESC: the predicate is a range seek from the window
--    start forward, not a "latest N" walk backwards.
--
-- Additive. No row is read, moved or dropped, and the indexes beside it stay.

CREATE INDEX IF NOT EXISTS idx_runs_team_started
    ON heartbeat_runs (team_id, started_at);
