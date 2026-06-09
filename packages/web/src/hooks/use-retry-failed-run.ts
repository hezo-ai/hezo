import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
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
				queryKey: queryKeys.projects.taskQueuedWakeups(projectId, taskId),
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.task(projectId, taskId) });
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to retry run');
		},
	});
}
