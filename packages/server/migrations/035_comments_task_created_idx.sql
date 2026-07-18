-- The lazy comments feed loads a skeleton of every comment for a task, ordered
-- by created_at. Back that ordering with a composite index so the query is an
-- index-ordered range scan with no separate sort step, keeping the initial
-- structural load fast as threads grow.
--
-- The composite (task_id, created_at) also covers every task_id-only lookup as a
-- prefix, so the standalone idx_comments_task becomes redundant and is dropped to
-- avoid the extra write-time index maintenance.
CREATE INDEX IF NOT EXISTS idx_comments_task_created ON task_comments (task_id, created_at);
DROP INDEX IF EXISTS idx_comments_task;
