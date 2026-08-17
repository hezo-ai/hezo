-- Drop `heartbeat_runs.process_pid`.
--
-- It has never been written. A run's work happens inside a container, exec'd
-- through the engine seam, so there is no host pid to record - liveness is the
-- in-process live-run registry plus the `HEZO_HEARTBEAT_RUN_ID` env marker every
-- reap path keys on. The column was nonetheless selected into the agent-run API
-- projection, so every row of a list of up to 200 shipped a permanently-null
-- field that read like liveness tracking.
--
-- Fixed-width, so unlike migration 041's `log_text` there is no TOAST graveyard
-- and no VACUUM follow-up.
--
-- `retry_of_run_id` is deliberately kept: it was equally unwritten until this
-- release, and now records which run a retry replaces, which is what bounds the
-- lost-run chain.

ALTER TABLE heartbeat_runs DROP COLUMN IF EXISTS process_pid;
