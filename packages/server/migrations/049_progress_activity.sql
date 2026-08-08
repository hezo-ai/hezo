-- The Progress page gains three recent-activity columns (actioned / created /
-- closed), written by the Captain during a progress-update run.
--
-- 1. `projects.progress_activity`
--    The columns are a *frozen snapshot*: the Captain picks the tasks and writes
--    every summary line itself, once per run, and the page renders what it wrote.
--    So the whole block is one document, stored as JSONB beside the summary it
--    ships with rather than as a child table. That keeps the write a single
--    `UPDATE projects` — summary and columns are atomic by construction and share
--    `progress_summary_updated_at` — and the read one column on a row the page
--    already fetches, with no join. Identifier and title are captured at write
--    time, so a task deleted between runs renders its captured row until the next
--    run drops it. Shape:
--      {"actioned":[{"identifier":"BE-1","title":"…","summary":"…"}],
--       "created":[…], "closed":[…]}
--    Defaults to '{}' so every existing project reads as "no snapshot yet".
--
-- The rest are indexes for the *candidate* queries that build the Captain's
-- prompt — the deterministic half of the feature. Each is paired with the query
-- it exists for, in the style of 047_hot_path_indexes.sql.
--
-- 2. `tasks (project_id, updated_at DESC) WHERE status NOT IN ('done','cancelled')`
--    The "recently actioned" candidate window, and the activity guard on the
--    progress-update due-check (has anything happened since the last snapshot?).
--    Partial rather than a composite on `status`, because `NOT IN` on the second
--    column of a composite cannot drive an ordered index scan — the partial
--    predicate moves the status test out of the key entirely.
--
-- 3. `tasks (project_id, updated_at DESC) WHERE status = 'done'`
--    The "recently closed" candidate window. `cancelled` is deliberately excluded
--    from the column, so the predicate is `= 'done'`, not a terminal-status set.
--
-- 4. `tasks (project_id, created_at DESC)`
--    The "recently created" candidate window — filter-then-sort-then-limit wants
--    the composite in that order.
--
-- 5. `heartbeat_runs (team_id, started_at DESC) WHERE task_id IS NOT NULL`
--    Recent task-scoped runs, the agent-work half of the "actioned" ranking.
--    The partial predicate is load-bearing beyond selectivity: a progress-update
--    run carries no `task_id`, so excluding NULLs is exactly what keeps the
--    Progress page from reporting on its own runs.
--
-- All additive. No existing row is read, moved or dropped; the new column is
-- defaulted, so existing projects keep their summaries untouched.

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS progress_activity JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_tasks_project_open_updated
    ON tasks (project_id, updated_at DESC)
    WHERE status NOT IN ('done', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_tasks_project_done_updated
    ON tasks (project_id, updated_at DESC)
    WHERE status = 'done';

CREATE INDEX IF NOT EXISTS idx_tasks_project_created
    ON tasks (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_team_started_task
    ON heartbeat_runs (team_id, started_at DESC)
    WHERE task_id IS NOT NULL;
