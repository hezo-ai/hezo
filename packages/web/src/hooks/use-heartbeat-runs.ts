import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface HeartbeatRun {
	id: string;
	member_id: string;
	company_id: string;
	issue_id: string | null;
	issue_identifier: string | null;
	issue_title: string | null;
	project_id: string | null;
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
	started_at: string;
	finished_at: string | null;
	exit_code: number | null;
	error: string | null;
	input_tokens: number;
	output_tokens: number;
	cost_cents: number | null;
	invocation_command: string | null;
	log_text: string | null;
	working_dir: string | null;
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export function isActiveRunStatus(status: RunStatus): boolean {
	return status === 'running' || status === 'queued';
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
