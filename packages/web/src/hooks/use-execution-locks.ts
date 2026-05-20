import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface ExecutionLock {
	id: string;
	issue_id: string;
	member_id: string;
	member_name: string;
	locked_at: string;
}

export interface ExecutionLockState {
	locks: ExecutionLock[];
}

export function useExecutionLock(teamId: string, issueId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'issues', issueId, 'lock'],
		queryFn: () => api.get<ExecutionLockState>(`/api/teams/${teamId}/issues/${issueId}/lock`),
		refetchInterval: 5_000,
	});
}
