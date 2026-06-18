import type { WakeupSource } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface HeartbeatRun {
	id: string;
	member_id: string;
	team_id: string;
	wakeup_id: string | null;
	task_id: string | null;
	task_identifier: string | null;
	task_title: string | null;
	project_id: string | null;
	project_slug: string | null;
	project_name: string | null;
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
	queued_reason: string | null;
	started_at: string | null;
	finished_at: string | null;
	exit_code: number | null;
	error: string | null;
	input_tokens: number;
	output_tokens: number;
	cost_cents: number | null;
	invocation_command: string | null;
	log_text: string | null;
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
	created_skills: { name: string; slug: string; created: boolean; source_url: string | null }[];
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

export function useHeartbeatRuns(projectId: string, agentId: string) {
	return useQuery({
		queryKey: queryKeys.projects.agentHeartbeatRuns(projectId, agentId),
		queryFn: () =>
			api.get<HeartbeatRun[]>(`/api/projects/${projectId}/agents/${agentId}/heartbeat-runs`),
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
