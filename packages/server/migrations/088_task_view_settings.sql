-- How the task page's folding cards (Progress Summary, Rules, Sub-tasks) open on
-- each task. One row per task, shared by everyone who opens it; a task with no
-- row shows the defaults, so there is nothing to backfill.
--
-- This is its own table, not a column on `tasks`, because `trg_tasks_updated`
-- stamps `tasks.updated_at` on every update of that row, and `updated_at` is read
-- as "this task had activity": list order, the Captain's progress-run due check,
-- the Coach's missed-review sweep, and the open-task list in agent prompts. A
-- reader folding a card is none of those.
--
-- `sections_open` maps a section key to true (open) or false (folded); only the
-- cards someone has toggled appear. The primary key serves the single-task read's
-- join, so no further index is needed.
CREATE TABLE task_view_settings (
    task_id       UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    sections_open JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
