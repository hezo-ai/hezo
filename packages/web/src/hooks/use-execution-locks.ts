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

export function useExecutionLock(companyId: string, issueId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'issues', issueId, 'lock'],
		queryFn: () =>
			api.get<ExecutionLockState>(`/api/companies/${companyId}/issues/${issueId}/lock`),
		refetchInterval: 5_000,
	});
}
