import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * Every cost read reports two figures side by side.
 *
 * `total_cents` is real spend and nothing else - it is what budgets are enforced
 * against, so it never absorbs the sibling. `notional_cents` is what the same
 * tokens would have cost at published rates on a run nobody is billed per token
 * for; it is shown, never enforced, and every surface that prints it has to say
 * so.
 */
interface CostTotals {
	total_cents: number;
	notional_cents: number;
}

export interface CostSummary extends CostTotals {
	summary?: Array<{ label: string; total_cents: number; notional_cents: number }>;
	entries?: Array<{
		id: string;
		amount_cents: number;
		description: string | null;
		created_at: string;
		member_name: string;
		/** False when the entry is an imputed figure rather than money spent. */
		billed: boolean;
	}>;
}

export function useCosts(
	projectId: string,
	params?: {
		group_by?: string;
		agent_id?: string;
		project_id?: string;
		from?: string;
		to?: string;
	},
) {
	return useQuery({
		queryKey: queryKeys.projects.costs(projectId, params),
		queryFn: () =>
			api.get<CostSummary>(`/api/projects/${projectId}/costs`, params as Record<string, string>),
	});
}

/**
 * Spend vs. limit for a single rolling window. Mirrors the server WindowStatus.
 *
 * `spentCents` is billed spend alone, because it is the figure the cap is
 * enforced against. A window's notional companion comes from the per-day series
 * instead, and is never folded into the bar or the percentage.
 */
export interface WindowStatus {
	spentCents: number;
	limitCents: number;
	overBudget: boolean;
}

export interface EntityBudgetStatus {
	daily: WindowStatus;
	weekly: WindowStatus;
	monthly: WindowStatus;
	overBudget: boolean;
}

export interface AgentBudgetStatus extends EntityBudgetStatus {
	agent_id: string;
	agent_title: string;
	/** The agent's own name, when it has one. Null means it goes by its role. */
	agent_name: string | null;
	agent_slug: string;
	runtime_status: string;
	/** Generated avatar spec; built-in CEO/Coach defaults resolve from the slug. */
	agent_avatar_spec: unknown;
	agent_over_budget: boolean;
	project_over_budget: boolean;
}

export interface BudgetStatus {
	project: EntityBudgetStatus;
	agents: AgentBudgetStatus[];
	/** Month-to-date run count (≈ cost entries) — drives the Budget hero's runs line. */
	runsThisMonth: number;
}

/** Project + per-agent budget status; powers the Budgets page and warning banner. */
export function useBudgetStatus(projectId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.projects.budgetStatus(projectId),
		queryFn: () => api.get<BudgetStatus>(`/api/projects/${projectId}/budget-status`),
		enabled: !!projectId && (options?.enabled ?? true),
	});
}

export interface DailyCostPoint extends CostTotals {
	day: string;
}

/** Per-day project spend total — powers the project "spend per day" chart. */
export function useDailyCostSeries(
	projectId: string,
	params?: { agent_id?: string; from?: string; to?: string },
) {
	const query = { group_by: 'day', ...params };
	return useQuery({
		queryKey: queryKeys.projects.costs(projectId, query),
		queryFn: () =>
			api.get<{ summary: DailyCostPoint[] } & CostTotals>(
				`/api/projects/${projectId}/costs`,
				query as Record<string, string>,
			),
		enabled: !!projectId,
	});
}

/**
 * The part of a per-day series that falls inside the current UTC month.
 *
 * The windows the budget API reports are billed-only, so a month-to-date
 * notional figure has to come from the day buckets - which are cut on the same
 * UTC boundary the server sums over.
 */
export function monthToDateNotionalCents(points: DailyCostPoint[] | undefined): number {
	const now = new Date();
	const firstOfMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
	return (points ?? []).reduce(
		(sum, p) => (p.day.slice(0, 10) >= firstOfMonth ? sum + p.notional_cents : sum),
		0,
	);
}

/** One day's spend for a single series (agent or adapter) in a breakdown. */
export interface AgentDailyCostPoint extends CostTotals {
	day: string;
	agent_id: string;
	agent_title: string;
	/** The agent's own name, when it has one. Null means it goes by its role. */
	agent_name: string | null;
}

export interface AdapterDailyCostPoint extends CostTotals {
	day: string;
	ai_provider_config_id: string | null;
	provider: string | null;
	adapter_label: string | null;
}

/** Per-day spend split by agent — powers the stacked "by agent" chart. */
export function useAgentDailyCostSeries(projectId: string) {
	const query = { group_by: 'day', breakdown: 'agent' };
	return useQuery({
		queryKey: queryKeys.projects.costs(projectId, query),
		queryFn: () =>
			api.get<{ summary: AgentDailyCostPoint[] } & CostTotals>(
				`/api/projects/${projectId}/costs`,
				query,
			),
		enabled: !!projectId,
	});
}

/** Per-day spend split by AI adapter configuration — powers the stacked "by adapter" chart. */
export function useAdapterDailyCostSeries(projectId: string) {
	const query = { group_by: 'day', breakdown: 'adapter' };
	return useQuery({
		queryKey: queryKeys.projects.costs(projectId, query),
		queryFn: () =>
			api.get<{ summary: AdapterDailyCostPoint[] } & CostTotals>(
				`/api/projects/${projectId}/costs`,
				query,
			),
		enabled: !!projectId,
	});
}
