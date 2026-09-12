-- The Coach's retrospective run: a task-less pass over a whole project's recent
-- shape, looking for the pathology no single task shows.
--
-- What prompted it: one project spent 1.78 billion input tokens in seven days on a
-- self-perpetuating verification loop, and the Coach reviewed 60 of those tasks
-- individually, across 65 runs, without flagging it. Every task was fine alone. The
-- loop existed only in how the work multiplied - 58 near-identical tasks, one of
-- them run 31 times in 17 hours, an asset library growing 70% in a week.

-- A third run kind beside 'task' and 'progress_update'. Like the progress-update
-- run it carries no task and reads across a project; unlike it, the subject is how
-- the work is behaving rather than how far it has got.
--
-- ADD VALUE, unlike RENAME VALUE in migration 009, cannot be used by any statement
-- later in the same transaction - and the runner wraps each migration file in one.
-- That is why the index below is predicated on `task_id IS NULL` rather than on
-- `kind = 'retrospective'`, which would be the tighter predicate and would fail.
-- Do not "improve" it.
ALTER TYPE heartbeat_run_kind ADD VALUE IF NOT EXISTS 'retrospective';

-- The anchor read behind both task-less due-checks: "when did this team last have a
-- run of this kind with no task?", asked on every Coach and Captain heartbeat.
--
-- Serves the new retrospective due-check and fixes an existing gap in the same
-- shape: `isProgressSnapshotDue` asks (team_id, task_id IS NULL, kind) today with
-- only idx_runs_team(team_id) under it, so every Captain heartbeat scans that team's
-- entire run history to find one max(). Partial on the task-less half because that
-- is the only half either query asks for, and it keeps the index tiny next to a
-- table where all but a handful of rows carry a task.
CREATE INDEX IF NOT EXISTS idx_runs_team_kind_started
    ON heartbeat_runs (team_id, kind, started_at DESC)
    WHERE task_id IS NULL;

-- Asset growth over the retrospective's window, read against the library total.
-- Only idx_assets_project(project_id) exists, so both the window seek and the
-- totals degrade to a full scan of the project's assets - 1,442 rows on the
-- instance this came from, and the figure that mattered was "70% of these were
-- created in the last seven days".
CREATE INDEX IF NOT EXISTS idx_assets_project_created
    ON assets (project_id, created_at DESC);

-- The Coach's sweep for a completed task whose review never ran, asked on its
-- heartbeat: recently closed tasks, oldest close first, across every project.
--
-- Under idx_tasks_status(team_id, status) this cannot be answered at all - the
-- Coach sweeps every team, so the leading column is not constrained and the query
-- falls to a full scan of the task table sorted by close time. Descending on the
-- timestamp because the same index also answers "what closed most recently", and a
-- btree scans either direction.
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
    ON tasks (status, updated_at DESC);
