-- Budgeting overhaul (HID-195).
--
-- Spend is now computed on demand from cost_entries over rolling UTC windows
-- (services/budget.ts) rather than tracked with running counters, and there is
-- no team budget — Hezo is project-centric. Limits live per rolling window
-- (daily/weekly/monthly; 0 = unlimited) on member_agents and projects.
--
-- This migration transforms the frozen 001 baseline into that shape, so existing
-- instances reach the same schema fresh installs build from 001. Forward-only;
-- additive columns default to 0 / NULL and the dropped running counters carried
-- no value worth preserving (spend is re-derived from cost_entries).

-- Teams: drop the old team-level budget + running counter (no team budget now).
ALTER TABLE teams DROP COLUMN budget_monthly_cents;
ALTER TABLE teams DROP COLUMN budget_used_cents;
ALTER TABLE teams DROP COLUMN budget_reset_at;

-- Agents: drop the running counter, add the daily/weekly windows alongside the
-- existing monthly_budget_cents. 0 = unlimited.
ALTER TABLE member_agents DROP COLUMN budget_used_cents;
ALTER TABLE member_agents DROP COLUMN budget_reset_at;
ALTER TABLE member_agents ADD COLUMN daily_budget_cents  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE member_agents ADD COLUMN weekly_budget_cents INTEGER NOT NULL DEFAULT 0;

-- Projects: gain their own per-window limits. 0 = unlimited.
ALTER TABLE projects ADD COLUMN daily_budget_cents   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN weekly_budget_cents  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN monthly_budget_cents INTEGER NOT NULL DEFAULT 0;

-- Team-type templates round-trip the daily/weekly windows too, so cloning a team
-- (snapshotTeamAsTemplate -> provisionTeamTemplate) mirrors the source agents'
-- per-window budgets instead of dropping them. Nullable, like monthly_budget_override.
ALTER TABLE team_template_agent_types ADD COLUMN daily_budget_override  INTEGER;
ALTER TABLE team_template_agent_types ADD COLUMN weekly_budget_override INTEGER;

-- The running-counter debit function is gone; spend is derived from cost_entries.
DROP FUNCTION IF EXISTS debit_agent_budget(UUID, INTEGER);

-- Windowed spend sums for budget enforcement scan by entity + created_at.
CREATE INDEX idx_costs_member_created  ON cost_entries(member_id, created_at);
CREATE INDEX idx_costs_project_created ON cost_entries(project_id, created_at);
