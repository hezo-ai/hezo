import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * Every usage read reports tokens: input (cached input included), output, and
 * their sum, which is the figure budgets count.
 */
export interface UsageTotals {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
}

/** One agent's usage, as `group_by: 'agent'` returns it. */
export interface AgentUsageRow extends UsageTotals {
	agent_id: string;
	agent_title: string | null;
	/** The agent's own name, when it has one. Null means it goes by its role. */
	agent_name: string | null;
}

/**
 * How many days of history a usage chart asks for: the newest page of the day
 * series, which the server pages by whole days.
 */
export const USAGE_CHART_DAYS = 180;

export interface UsageSummary extends UsageTotals {
	summary?: AgentUsageRow[];
	entries?: Array<{
		id: string;
		input_tokens: number;
		output_tokens: number;
		description: string | null;
		created_at: string;
	}>;
	/** Set on the ungrouped read: the entries page by cursor, the totals cover every entry. */
	next_cursor?: string | null;
	has_more?: boolean;
}

export function useUsage(
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
		queryKey: queryKeys.projects.usage(projectId, params),
		queryFn: () =>
			api.get<UsageSummary>(`/api/projects/${projectId}/usage`, params as Record<string, string>),
	});
}

/** Usage vs. limit for a single rolling window, in tokens. Mirrors the server WindowStatus. */
export interface WindowStatus {
	usedTokens: number;
	limitTokens: number;
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
	/** Month-to-date usage entries (one per run or chat turn) - drives the Budget hero's runs line. */
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

export interface DailyUsagePoint extends UsageTotals {
	day: string;
}

/** Per-day project usage total - powers the project "tokens per day" chart. */
export function useDailyUsageSeries(
	projectId: string,
	params?: { agent_id?: string; from?: string; to?: string },
) {
	const query = { group_by: 'day', limit: String(USAGE_CHART_DAYS), ...params };
	return useQuery({
		queryKey: queryKeys.projects.usage(projectId, query),
		queryFn: () =>
			api.get<{ summary: DailyUsagePoint[] } & UsageTotals>(
				`/api/projects/${projectId}/usage`,
				query as Record<string, string>,
			),
		enabled: !!projectId,
	});
}

/** One day's usage for a single series (agent or adapter) in a breakdown. */
export interface AgentDailyUsagePoint extends UsageTotals {
	day: string;
	agent_id: string;
	agent_title: string;
	/** The agent's own name, when it has one. Null means it goes by its role. */
	agent_name: string | null;
}

export interface AdapterDailyUsagePoint extends UsageTotals {
	day: string;
	ai_provider_config_id: string | null;
	provider: string | null;
	adapter_label: string | null;
}

/** Per-day usage split by agent - powers the stacked "by agent" chart. */
export function useAgentDailyUsageSeries(projectId: string) {
	const query = { group_by: 'day', breakdown: 'agent', limit: String(USAGE_CHART_DAYS) };
	return useQuery({
		queryKey: queryKeys.projects.usage(projectId, query),
		queryFn: () =>
			api.get<{ summary: AgentDailyUsagePoint[] } & UsageTotals>(
				`/api/projects/${projectId}/usage`,
				query,
			),
		enabled: !!projectId,
	});
}

/** Per-day usage split by AI adapter configuration - powers the stacked "by adapter" chart. */
export function useAdapterDailyUsageSeries(projectId: string) {
	const query = { group_by: 'day', breakdown: 'adapter', limit: String(USAGE_CHART_DAYS) };
	return useQuery({
		queryKey: queryKeys.projects.usage(projectId, query),
		queryFn: () =>
			api.get<{ summary: AdapterDailyUsagePoint[] } & UsageTotals>(
				`/api/projects/${projectId}/usage`,
				query,
			),
		enabled: !!projectId,
	});
}
