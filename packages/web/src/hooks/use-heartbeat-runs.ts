import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface HeartbeatRun {
	id: string;
	member_id: string;
	company_id: string;
	status: 'running' | 'completed' | 'failed';
	started_at: string;
	finished_at: string | null;
	exit_code: number | null;
	error: string | null;
	cost_cents: number | null;
	stdout_excerpt: string | null;
	stderr_excerpt: string | null;
}

export function useHeartbeatRuns(companyId: string, agentId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'agents', agentId, 'heartbeat-runs'],
		queryFn: () =>
			api.get<HeartbeatRun[]>(`/api/companies/${companyId}/agents/${agentId}/heartbeat-runs`),
		refetchInterval: 10_000,
	});
}
