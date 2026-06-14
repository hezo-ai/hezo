import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface CostSummary {
	summary?: Array<{ label: string; total_cents: number }>;
	entries?: Array<{
		id: string;
		amount_cents: number;
		description: string | null;
		created_at: string;
		member_name: string;
	}>;
	total_cents: number;
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

/** Spend vs. limit for a single rolling window. Mirrors the server WindowStatus. */
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
	agent_slug: string;
	runtime_status: string;
	agent_over_budget: boolean;
	project_over_budget: boolean;
}

export interface BudgetStatus {
	project: EntityBudgetStatus;
	agents: AgentBudgetStatus[];
}

/** Project + per-agent budget status; powers the Budgets page and warning banner. */
export function useBudgetStatus(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.budgetStatus(projectId),
		queryFn: () => api.get<BudgetStatus>(`/api/projects/${projectId}/budget-status`),
		enabled: !!projectId,
	});
}

export interface DailyCostPoint {
	day: string;
	total_cents: number;
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
			api.get<{ summary: DailyCostPoint[]; total_cents: number }>(
				`/api/projects/${projectId}/costs`,
				query as Record<string, string>,
			),
		enabled: !!projectId,
	});
}

/** One day's spend for a single series (agent or adapter) in a breakdown. */
export interface AgentDailyCostPoint {
	day: string;
	agent_id: string;
	agent_title: string;
	total_cents: number;
}

export interface AdapterDailyCostPoint {
	day: string;
	ai_provider_config_id: string | null;
	provider: string | null;
	adapter_label: string | null;
	total_cents: number;
}

/** Per-day spend split by agent — powers the stacked "by agent" chart. */
export function useAgentDailyCostSeries(projectId: string) {
	const query = { group_by: 'day', breakdown: 'agent' };
	return useQuery({
		queryKey: queryKeys.projects.costs(projectId, query),
		queryFn: () =>
			api.get<{ summary: AgentDailyCostPoint[]; total_cents: number }>(
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
			api.get<{ summary: AdapterDailyCostPoint[]; total_cents: number }>(
				`/api/projects/${projectId}/costs`,
				query,
			),
		enabled: !!projectId,
	});
}
