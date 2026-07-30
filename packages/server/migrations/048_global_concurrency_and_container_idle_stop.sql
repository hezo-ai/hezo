-- The concurrency cap becomes one global, instance-wide limit on ACTIVE
-- CONTAINERS (system_meta key 'max_active_containers'; an absent key means a
-- default computed from host memory), replacing the per-project run column. A
-- per-project cap cannot bound what the host actually experiences: N projects
-- x M runs each all land on the same box.
ALTER TABLE projects DROP COLUMN max_concurrent_runs;

-- Memory cap: NULL now means "inherit the instance-wide default"
-- (system_meta 'default_ram_cap_per_container_gb', default 2). Rows on the old
-- hardcoded 16GiB default move to inherit -- on a small host that cap is a
-- no-op (the prod OOM incident: a runaway in-container process triggered a
-- GLOBAL OOM kill instead of a contained cgroup one). Explicitly customized
-- values are preserved as per-project overrides.
ALTER TABLE projects ALTER COLUMN memory_limit_gib DROP NOT NULL;
ALTER TABLE projects ALTER COLUMN memory_limit_gib DROP DEFAULT;
UPDATE projects SET memory_limit_gib = NULL WHERE memory_limit_gib = 16;

-- Idle-stop floor: when this project's container last entered 'running'. The
-- idle-stop cron never stops a container younger than the idle timeout, so a
-- manual start or fresh provision always gets one full idle window. Backfilled
-- to now() for currently-running containers so an upgrade grants the same grace
-- instead of stopping everything on the first tick.
ALTER TABLE projects ADD COLUMN container_last_started_at TIMESTAMPTZ;
UPDATE projects SET container_last_started_at = now() WHERE container_status = 'running';

-- Idle-stop cron: "projects with a run finished inside the idle window" is a
-- bare recency range scan on finished_at. The existing idx_runs_member_finished
-- (047) leads on member_id and cannot serve a recency-only predicate.
CREATE INDEX idx_runs_finished ON heartbeat_runs (finished_at DESC);

-- Idle-stop cron: in-flight chat turns hold a container up. Partial on the two
-- live states so the index carries only the working set, same shape as
-- idx_wakeups_pending (047).
CREATE INDEX idx_chat_messages_inflight ON chat_messages (session_id)
    WHERE status IN ('pending', 'streaming');
