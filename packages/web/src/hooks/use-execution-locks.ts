import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface ExecutionLock {
	id: string;
	task_id: string;
	member_id: string;
	member_name: string;
	locked_at: string;
}

export interface ExecutionLockState {
	locks: ExecutionLock[];
}

export function useExecutionLock(projectId: string, taskId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'tasks', taskId, 'lock'],
		queryFn: () => api.get<ExecutionLockState>(`/api/projects/${projectId}/tasks/${taskId}/lock`),
		refetchInterval: 5_000,
	});
}
