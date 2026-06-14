-- Reshape the agent runtime-status enum.
--
-- The single `paused` value conflated two unrelated things and had no real
-- producer: a human turning an agent off is `admin_status = 'disabled'` (a
-- separate axis that also unassigns tasks), while the budget gate reused
-- `paused` to throttle an over-budget agent — hiding *why* it was paused.
--
-- Drop `paused` entirely (manual on/off lives in `admin_status`) and replace it
-- with two scoped, reactive budget pauses distinguished by which limit tripped.
-- The window that tripped (daily/weekly/monthly) is deliberately not encoded —
-- all three pause and resume identically.
--
-- Postgres can't drop an enum value in place, so recreate the type and swap the
-- one column that uses it (`member_agents.runtime_status`) over. Any existing
-- `paused` row (only the old budget gate ever set it) maps to `idle`; the budget
-- gate re-pauses with the correct scoped state on the next run.
CREATE TYPE agent_runtime_status_new AS ENUM (
    'active', 'idle', 'out_of_agent_budget', 'out_of_project_budget'
);

ALTER TABLE member_agents ALTER COLUMN runtime_status DROP DEFAULT;
ALTER TABLE member_agents
    ALTER COLUMN runtime_status TYPE agent_runtime_status_new
    USING (
        CASE runtime_status::text
            WHEN 'paused' THEN 'idle'
            ELSE runtime_status::text
        END
    )::agent_runtime_status_new;
ALTER TABLE member_agents ALTER COLUMN runtime_status SET DEFAULT 'idle';

DROP TYPE agent_runtime_status;
ALTER TYPE agent_runtime_status_new RENAME TO agent_runtime_status;
