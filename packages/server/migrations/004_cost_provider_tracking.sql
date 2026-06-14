-- Cost provider tracking + drop team cost dimension.
--
-- Cost is project/agent/adapter-scoped now — never team-scoped. Budget
-- enforcement (services/budget.ts) already keys off member_id and project_id;
-- cost_entries.team_id was load-bearing only for cost *reads*, which we re-scope
-- to project_id. So drop the team dimension from cost entirely.
--
-- We also start attributing each cost to the AI adapter configuration that
-- produced it (ai_provider_configs row + provider snapshot), captured at run
-- completion. The run carries the resolved config through heartbeat_runs.
--
-- Forward-only. Existing cost rows keep project_id; the new provider columns are
-- NULL for historical rows (surfaced as "Unattributed"). Rows with a NULL
-- project_id (task-less runs) become unattributable to any project page —
-- acceptable, since cost is project-centric.

-- cost_entries: drop the team dimension.
DROP INDEX IF EXISTS idx_costs_team;
ALTER TABLE cost_entries DROP COLUMN team_id;

-- cost_entries: attribute spend to the AI adapter configuration that produced it.
-- ai_provider_config_id keeps the FK (ON DELETE SET NULL so deleting a config
-- doesn't erase history); provider is a snapshot that survives config deletion.
ALTER TABLE cost_entries ADD COLUMN ai_provider_config_id UUID REFERENCES ai_provider_configs(id) ON DELETE SET NULL;
ALTER TABLE cost_entries ADD COLUMN provider ai_provider;
CREATE INDEX idx_costs_provider_config ON cost_entries(ai_provider_config_id);

-- heartbeat_runs: carry the resolved config from run start to the cost-recording
-- step (recordRunCostAndEnforce reads it back by run id).
ALTER TABLE heartbeat_runs ADD COLUMN ai_provider_config_id UUID REFERENCES ai_provider_configs(id) ON DELETE SET NULL;
ALTER TABLE heartbeat_runs ADD COLUMN provider ai_provider;
