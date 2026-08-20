-- Remove the 'review' task status. It carried no server behaviour: no wakeup, no
-- cron, no transition guard, no Coach trigger and no approval linkage. It was one
-- more open state beside backlog/in_progress/blocked, and the handoff it looked
-- like it performed was always the active @-mention next to it. A task sitting in
-- 'review' was open work in someone's hands, so it maps onto 'in_progress'.
--
-- Postgres can't drop a value from an enum in place, so the type is recreated.
-- task_status is referenced only by tasks.status; no views, functions, triggers,
-- generated columns or other columns depend on it (tasks.search_tsv reads
-- identifier/title/description only, and trg_tasks_updated touches updated_at).
--
-- Three indexes read tasks.status, and they do NOT all survive the swap alike.
-- idx_tasks_status (team_id, status) from 001 is a plain btree, so the column
-- rewrite rebuilds it automatically. The two partial indexes added by 049 are
-- different: their stored predicates carry enum literals bound to the OLD type,
-- which the rewrite does not retype, so the comparison fails as
-- `operator does not exist: task_status <> task_status_old`. They must be dropped
-- before the swap and recreated after. This is the one way migration 004 (which
-- removed 'closed' before 049 existed) is not a complete template.

-- 1. Re-home existing 'review' tasks onto 'in_progress' while the value still exists.
UPDATE tasks SET status = 'in_progress'::task_status WHERE status = 'review'::task_status;

-- 2. Drop the partial indexes whose predicates bind the old enum type.
DROP INDEX IF EXISTS idx_tasks_project_open_updated;
DROP INDEX IF EXISTS idx_tasks_project_done_updated;

-- 3. Recreate task_status without 'review'. The column DEFAULT binds the old
--    type, so drop it first, swap the type, then re-add it.
ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;
ALTER TYPE task_status RENAME TO task_status_old;
CREATE TYPE task_status AS ENUM ('backlog', 'in_progress', 'blocked', 'done', 'cancelled');
ALTER TABLE tasks ALTER COLUMN status TYPE task_status USING status::text::task_status;
ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'backlog';
DROP TYPE task_status_old;

-- 4. Recreate them against the new type, verbatim from 049.
CREATE INDEX IF NOT EXISTS idx_tasks_project_open_updated
    ON tasks (project_id, updated_at DESC)
    WHERE status NOT IN ('done', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_tasks_project_done_updated
    ON tasks (project_id, updated_at DESC)
    WHERE status = 'done';
