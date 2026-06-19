-- 011_heartbeat_run_no_work.sql
-- Let an agent explicitly declare that a run had nothing to do. Some heartbeats
-- legitimately wake an agent when there is no actionable work — e.g. a Captain
-- on a planning/epic ticket whose sub-tasks are still open. The agent does the
-- right thing (evaluates, concludes nothing to act on, ends the turn) but writes
-- nothing, so the produced_output check (010) would mark the run failed.
--
-- The `report_no_work` MCP tool sets `reported_no_work` (and records a one-line
-- `no_work_reason`) on the run row. The run-completion path treats a clean exit
-- with `reported_no_work = true` as a success, distinct from `produced_output`
-- (which still means the run wrote persisted data). A silent empty run — one that
-- neither wrote anything nor declared no work — still fails as before.

ALTER TABLE heartbeat_runs ADD COLUMN reported_no_work BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE heartbeat_runs ADD COLUMN no_work_reason TEXT;
