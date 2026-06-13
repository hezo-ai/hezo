/**
 * Per-agent spend limits and how they're resolved when provisioning an agent
 * from a team type. Single source of truth shared by both provisioning paths —
 * builtin agents (Captain/Coach) in `team-template-apply.ts` and worker agents
 * in `team-template-provision.ts` — so a new budget window is added here once
 * instead of being threaded through each path independently.
 *
 * Spend itself is derived on demand from `cost_entries` over rolling UTC windows
 * (see `services/budget.ts`); these are only the limits. 0 = unlimited.
 */

/** Effective per-rolling-window limits written onto a `member_agents` row. */
export interface AgentBudgets {
	monthlyBudgetCents: number;
	dailyBudgetCents: number;
	weeklyBudgetCents: number;
}

/**
 * The per-agent-type budget override columns a team type carries
 * (`team_template_agent_types`). NULL means "inherit the agent-type default".
 */
export interface AgentBudgetOverrides {
	monthly_budget_override: number | null;
	daily_budget_override: number | null;
	weekly_budget_override: number | null;
}

/**
 * Resolve an agent's effective budgets: the team-type override when set, else
 * the agent-type default. Agent types carry only a monthly default; daily and
 * weekly have no agent-type default and fall back to unlimited (0).
 */
export function resolveAgentBudgets(
	agentTypeMonthlyCents: number,
	overrides: Partial<AgentBudgetOverrides> | null | undefined,
): AgentBudgets {
	return {
		monthlyBudgetCents: overrides?.monthly_budget_override ?? agentTypeMonthlyCents,
		dailyBudgetCents: overrides?.daily_budget_override ?? 0,
		weeklyBudgetCents: overrides?.weekly_budget_override ?? 0,
	};
}
