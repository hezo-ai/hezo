import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { toast } from './use-toast';

interface RetryFailedRunArgs {
	projectId: string;
	taskId: string;
}

export function useRetryFailedRun({ projectId, taskId }: RetryFailedRunArgs) {
	return useMutation({
		mutationFn: (runId: string) =>
			api.post<{ dispatched: boolean }>(
				`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}/retry`,
				{},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'tasks', taskId, 'queued-wakeups'],
			});
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'tasks', taskId, 'comments'],
			});
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tasks', taskId] });
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to retry run');
		},
	});
}
