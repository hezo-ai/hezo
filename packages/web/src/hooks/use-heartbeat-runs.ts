import { type HeartbeatRunKind, RunOutcomeFilter, type WakeupSource } from '@hezo/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, nextOffsetPageParam } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface HeartbeatRun {
	id: string;
	member_id: string;
	team_id: string;
	wakeup_id: string | null;
	task_id: string | null;
	kind: HeartbeatRunKind;
	task_identifier: string | null;
	task_title: string | null;
	project_id: string | null;
	project_slug: string | null;
	project_name: string | null;
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
	queued_reason: string | null;
	created_at: string;
	/** Null until the run goes running - a run that ended before that never gets one. */
	started_at: string | null;
	finished_at: string | null;
	exit_code: number | null;
	error: string | null;
	input_tokens: number;
	output_tokens: number;
	cost_cents: number | null;
	/** True when the usage above is a mid-run snapshot (the run was interrupted before it finished). */
	usage_partial: boolean;
	invocation_command: string | null;
	/**
	 * Full run log. Present only on single-run reads (`useHeartbeatRun`, the
	 * terminate response) - the paginated list omits it and sends `log_length`
	 * instead, since a page of 200 runs would otherwise carry gigabytes of text.
	 */
	log_text?: string | null;
	/** Character length of the run's log. Sent by the list in place of `log_text`. */
	log_length?: number;
	working_dir: string | null;
	trigger_source: WakeupSource | null;
	trigger_payload: Record<string, unknown> | null;
	trigger_comment_id: string | null;
	/** Deep-link slug for the triggering comment (`#comment-<public_id>`). */
	trigger_comment_public_id: string | null;
	trigger_actor_member_id: string | null;
	trigger_actor_slug: string | null;
	trigger_actor_title: string | null;
	trigger_comment_task_id: string | null;
	trigger_comment_task_identifier: string | null;
	trigger_comment_project_slug: string | null;
	run_comment_id: string | null;
	/** Deep-link slug for this run's own comment (`#comment-<public_id>`). */
	run_comment_public_id: string | null;
	created_tasks: { id: string; identifier: string; title: string; project_slug: string }[];
	created_docs: { filename: string; project_slug: string }[];
	created_skills: {
		name: string;
		slug: string;
		created: boolean;
		source_url: string | null;
		/** Owning project slug for a project-scoped skill; null for a global skill. */
		project_slug: string | null;
	}[];
	proposed_skills: { name: string; slug: string }[];
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export function isActiveRunStatus(status: RunStatus): boolean {
	return status === 'running' || status === 'queued';
}

export function getRunWaitingMessage(status: RunStatus, queuedReason?: string | null): string {
	if (status === 'queued') return `Queued — ${queuedReason ?? 'waiting to start'}…`;
	if (status === 'running') return 'Waiting for log output…';
	return 'No output.';
}

export function useHeartbeatRuns(
	projectId: string,
	agentId: string,
	options?: { perPage?: number; filter?: RunOutcomeFilter },
) {
	const perPage = options?.perPage ?? 50;
	// Same default as the route and the server: nothing hidden unless asked.
	const filter = options?.filter ?? RunOutcomeFilter.All;
	return useInfiniteQuery({
		// `filter` has to be in the key: the poll below refetches every loaded
		// page, so sharing a key across filters would write one filter's rows into
		// another's cache entry.
		queryKey: queryKeys.projects.agentHeartbeatRunsInfinite(projectId, agentId, {
			per_page: String(perPage),
			filter,
		}),
		initialPageParam: 1,
		queryFn: ({ pageParam }) =>
			api.getPaginated<HeartbeatRun>(
				`/api/projects/${projectId}/agents/${agentId}/heartbeat-runs`,
				{ page: String(pageParam), per_page: String(perPage), filter },
			),
		getNextPageParam: nextOffsetPageParam,
		// Poll for new runs / status changes; refetches every loaded page.
		refetchInterval: 10_000,
	});
}

export function useHeartbeatRun(projectId: string, agentId: string, runId: string) {
	const enabled = Boolean(projectId && agentId && runId);
	return useQuery({
		queryKey: queryKeys.projects.agentHeartbeatRun(projectId, agentId, runId),
		queryFn: () =>
			api.get<HeartbeatRun>(`/api/projects/${projectId}/agents/${agentId}/heartbeat-runs/${runId}`),
		enabled,
		refetchInterval: (query) => {
			if (!enabled) return false;
			const status = query.state.data?.status;
			return status === 'running' || status === 'queued' ? 2_000 : false;
		},
	});
}
