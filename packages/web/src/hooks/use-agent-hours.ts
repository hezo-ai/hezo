import type { HoursBucket } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/** One (bucket, agent) cell of the hours series. `seconds` is summed wall clock. */
export interface AgentHoursBucketPoint {
	bucket: string;
	agent_id: string;
	agent_title: string;
	/** The agent's own name, when it has one. Null means it goes by its role. */
	agent_name: string | null;
	agent_slug: string | null;
	seconds: number;
	run_count: number;
}

/** One agent's three rolling windows, on the same UTC boundaries the budget windows use. */
export interface AgentHoursRow {
	agent_id: string;
	agent_title: string;
	agent_name: string | null;
	agent_slug: string | null;
	today_seconds: number;
	week_seconds: number;
	month_seconds: number;
	month_runs: number;
}

export interface AgentHoursTotals {
	today_seconds: number;
	week_seconds: number;
	month_seconds: number;
	month_runs: number;
	prev_week_seconds: number;
	active_today: number;
}

export interface AgentHours {
	bucket: HoursBucket;
	buckets: AgentHoursBucketPoint[];
	/** Ordered by month-to-date time, largest first — the order the page renders in. */
	agents: AgentHoursRow[];
	totals: AgentHoursTotals;
}

/**
 * Per-agent wall-clock time for a project, powering the Activity page's Hours
 * tab. One request serves the chart, the summary tiles and the per-agent table,
 * so switching bucket size is the only thing that refetches.
 */
export function useAgentHours(projectId: string, bucket: HoursBucket) {
	return useQuery({
		queryKey: queryKeys.projects.agentHours(projectId, bucket),
		queryFn: () => api.get<AgentHours>(`/api/projects/${projectId}/agent-hours`, { bucket }),
		enabled: !!projectId,
	});
}
