-- 009_heartbeat_run_produced_output.sql
-- Record whether an agent run produced any persisted output. A run only counts
-- as a useful success if it wrote something — code changes in the task worktree,
-- or a Hezo write (comment, task, document, blocker, reaction, credential
-- request, …). Exit code 0 alone is not enough: a model that drifts into plan
-- mode can exit cleanly having only described a plan, which previously read as a
-- green "succeeded" while nothing actually happened.
--
-- The flag is set to true mid-run by the MCP tool layer (on any write tool) and
-- by a post-run worktree diff. The run-completion path treats exit-0-but-false
-- as a failure so the no-op surfaces instead of masquerading as success.

ALTER TABLE heartbeat_runs ADD COLUMN produced_output BOOLEAN NOT NULL DEFAULT false;
