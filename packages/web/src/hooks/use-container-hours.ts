import type { HoursBucket } from '@hezo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

/**
 * Container hours - what the instance's containers cost in uptime.
 *
 * **A different quantity from `use-agent-hours`, and the one that gets billed.**
 * That one sums per-agent run wall clock, which over-counts (concurrent runs
 * share one container) and under-counts (build time, warm-idle time and the
 * assistant chat's container are all billed and none of them is a run). This
 * reads the uptime ledger: one row per running stretch.
 */

/** One bucket of the series. `chat_seconds` is the part the assistant chat held. */
export interface ContainerHoursBucket {
	bucket: string;
	seconds: number;
	chat_seconds: number;
}

/** One project's share of a bucket, for the instance-wide stacked view. */
export interface ContainerHoursProjectBucket extends ContainerHoursBucket {
	/** Null for hours billed to a project that has since been deleted. */
	project_id: string | null;
	project_name: string;
	project_slug: string | null;
}

export interface ContainerHoursTotals {
	today_seconds: number;
	week_seconds: number;
	/**
	 * So far this container-hours window - the figure the cap is enforced against.
	 *
	 * Not a month: a deployment may anchor the window to a billing day, so the
	 * page reads the period off `window_start` and `window_end` rather than
	 * assuming one.
	 */
	window_seconds: number;
	window_chat_seconds: number;
	prev_window_seconds: number;
	/** Stretches open right now - containers currently accruing. */
	open_intervals: number;
	window_start: string;
	window_end: string;
}

export interface ProjectContainerHours {
	bucket: HoursBucket;
	buckets: ContainerHoursBucket[];
	totals: ContainerHoursTotals;
}

export interface InstanceContainerHours extends ProjectContainerHours {
	by_project: ContainerHoursProjectBucket[];
	/** The hours allowance for one window. 0 is unlimited, and the default. */
	monthly_hours: number;
	/**
	 * Whether container hours cost anything on this backend. False on a local
	 * daemon, where the series is observability rather than a budget - the page
	 * leaves the cap controls out rather than inviting an operator to budget a
	 * resource nobody bills them for.
	 */
	metered: boolean;
	/** Set when this deployment fixed the allowance, so the control renders locked. */
	monthly_hours_pinned: boolean;
	/** Who fixed it and where to change it, or null when nothing is pinned. */
	policy: { managed_by: string; manage_url: string | null } | null;
}

/** One project's container hours. Serves the tiles and the chart from one request. */
export function useProjectContainerHours(projectId: string, bucket: HoursBucket) {
	return useQuery({
		queryKey: queryKeys.projects.containerHours(projectId, bucket),
		queryFn: () =>
			api.get<ProjectContainerHours>(`/api/projects/${projectId}/container-hours`, { bucket }),
		enabled: !!projectId,
	});
}

/** Instance-wide container hours, split by project. Superuser-only server-side. */
export function useInstanceContainerHours(bucket: HoursBucket) {
	return useQuery({
		queryKey: queryKeys.containerHours(bucket),
		queryFn: () => api.get<InstanceContainerHours>('/api/container-hours', { bucket }),
	});
}

/**
 * Set the hours allowance.
 *
 * Invalidate-and-refetch rather than optimistic: the server clamps the value,
 * and the figure it stores is what every admission check reads - so showing the
 * typed number as if it were in force before the server agrees would misreport a
 * limit that gates real work.
 */
export function useSetMonthlyContainerHours() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (monthlyHours: number) =>
			api.patch<{ monthly_hours: number }>('/api/container-hours', {
				monthly_hours: monthlyHours,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['instance', 'container-hours'] });
		},
	});
}
