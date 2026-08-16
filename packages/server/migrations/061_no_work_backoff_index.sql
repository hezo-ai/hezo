-- Index for the no-work backoff, which runs once per agent dispatch.
--
-- `heartbeat_runs (member_id, task_id, finished_at DESC)`
--    `noWorkCooldownActive` asks for one row: this agent's most recent finished
--    run on this task. That is filter-then-sort-then-limit on exactly these
--    three columns, so the composite serves it as a single index seek.
--
--    The nearest existing indexes cannot. `idx_runs_member_finished`
--    (member_id, finished_at DESC) from 047 has the right shape but no task
--    column, so it walks every run the agent has ever finished, newest first,
--    discarding the ones on other tasks until it reaches this task's - and an
--    agent that works many tasks pays for all of them on every dispatch.
--    `idx_runs_task_started` is keyed on started_at, which is not the ordering
--    this asks for. `heartbeat_runs` is never pruned, so both degrade with the
--    instance's whole run history rather than with anything bounded.
--
-- Additive. No row is read, moved or dropped, and the indexes beside it stay.

CREATE INDEX IF NOT EXISTS idx_runs_member_task_finished
    ON heartbeat_runs (member_id, task_id, finished_at DESC);
