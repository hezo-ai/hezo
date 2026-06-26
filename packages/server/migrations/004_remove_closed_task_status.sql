-- Remove the 'closed' task status. Terminal states are now 'done' (final;
-- the Coach reviews a done ticket for prompt-learning but no longer changes its
-- status) and 'cancelled' (abandoned). Any task sitting in 'closed' was a
-- Coach-reviewed completion, so it maps onto 'done'.
--
-- Postgres can't drop a value from an enum in place, so the type is recreated.
-- task_status is referenced only by tasks.status (and the idx_tasks_status btree
-- index, which the column rewrite rebuilds automatically) — no views, functions,
-- triggers, or other columns depend on it.

-- 1. Re-home existing 'closed' tasks onto 'done' while the value still exists.
UPDATE tasks SET status = 'done'::task_status WHERE status = 'closed'::task_status;

-- 2. Recreate task_status without 'closed'. The column DEFAULT binds the old
--    type, so drop it first, swap the type, then re-add it.
ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;
ALTER TYPE task_status RENAME TO task_status_old;
CREATE TYPE task_status AS ENUM ('backlog', 'in_progress', 'review', 'blocked', 'done', 'cancelled');
ALTER TABLE tasks ALTER COLUMN status TYPE task_status USING status::text::task_status;
ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'backlog';
DROP TYPE task_status_old;
