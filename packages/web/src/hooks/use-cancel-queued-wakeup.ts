import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { toast } from './use-toast';

interface CancelQueuedWakeupArgs {
	projectId: string;
	taskId: string;
}

export function useCancelQueuedWakeup({ projectId, taskId }: CancelQueuedWakeupArgs) {
	return useMutation({
		mutationFn: (wakeupId: string) =>
			api.post<{ cancelled: boolean }>(
				`/api/projects/${projectId}/tasks/${taskId}/queued-wakeups/${wakeupId}/cancel`,
				{},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskQueuedWakeups(projectId, taskId),
			});
			// Surface the system comment recording the cancellation.
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			});
			// Refresh the single queued_wakeup badge / has_active_run on the task.
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.task(projectId, taskId) });
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to cancel queued agent');
		},
	});
}
