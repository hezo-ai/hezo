import type { WakeupSource } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface HeartbeatRun {
	id: string;
	member_id: string;
	company_id: string;
	wakeup_id: string | null;
	issue_id: string | null;
	issue_identifier: string | null;
	issue_title: string | null;
	project_id: string | null;
	project_slug: string | null;
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
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
	trigger_actor_member_id: string | null;
	trigger_actor_slug: string | null;
	trigger_actor_title: string | null;
	trigger_comment_issue_id: string | null;
	trigger_comment_issue_identifier: string | null;
	trigger_comment_project_slug: string | null;
	created_issues: { id: string; identifier: string; title: string; project_slug: string }[];
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export function isActiveRunStatus(status: RunStatus): boolean {
	return status === 'running' || status === 'queued';
}

export function getRunWaitingMessage(status: RunStatus): string {
	if (status === 'queued') return 'Queued — waiting for prior run on this credential…';
	if (status === 'running') return 'Waiting for log output…';
	return 'No output.';
}

export function useHeartbeatRuns(companyId: string, agentId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'agents', agentId, 'heartbeat-runs'],
		queryFn: () =>
			api.get<HeartbeatRun[]>(`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs`),
		refetchInterval: 10_000,
	});
}

export function useHeartbeatRun(companyId: string, agentId: string, runId: string) {
	const enabled = Boolean(companyId && agentId && runId);
	return useQuery({
		queryKey: ['companies', companyId, 'agents', agentId, 'heartbeat-runs', runId],
		queryFn: () =>
			api.get<HeartbeatRun>(
				`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs/${runId}`,
			),
		enabled,
		refetchInterval: (query) => {
			if (!enabled) return false;
			const status = query.state.data?.status;
			return status === 'running' || status === 'queued' ? 2_000 : false;
		},
	});
}
