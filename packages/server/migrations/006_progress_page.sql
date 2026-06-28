-- Progress page: per-goal run activity + a Captain-maintained project progress summary.
--
-- Additive only; preserves all existing data. Both new task_comments and projects columns are
-- nullable / defaulted, so every existing row stays correct with no backfill.

-- Attribute an agent-authored comment to the heartbeat run that wrote it. Mirrors
-- tasks.created_by_run_id. NULL for human/board comments and system/automation comments.
-- Powers the goal detail page's per-goal run feed ("this goal-check run commented on task X").
ALTER TABLE task_comments
  ADD COLUMN created_by_run_id UUID REFERENCES heartbeat_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_comments_created_by_run
  ON task_comments(created_by_run_id) WHERE created_by_run_id IS NOT NULL;

-- Captain-maintained, project-level progress summary shown at the top of the Progress page:
-- a concise markdown blurb of work done / in progress / yet to do. Refreshed during goal-check
-- runs via the update_project_progress MCP tool. Empty string = not yet written.
ALTER TABLE projects ADD COLUMN progress_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN progress_summary_updated_at TIMESTAMPTZ;
