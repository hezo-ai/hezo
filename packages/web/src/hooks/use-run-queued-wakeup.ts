import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { toast } from './use-toast';

interface RunQueuedWakeupArgs {
	teamId: string;
	taskId: string;
}

export function useRunQueuedWakeup({ teamId, taskId }: RunQueuedWakeupArgs) {
	return useMutation({
		mutationFn: (wakeupId: string) =>
			api.post<{ dispatched: boolean }>(
				`/api/teams/${teamId}/tasks/${taskId}/queued-wakeups/${wakeupId}/run-now`,
				{},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', taskId, 'queued-wakeups'],
			});
			// Surface the system comment recording the manual start.
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
			});
			// Refresh the single queued_wakeup badge / has_active_run on the task.
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'tasks', taskId] });
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to start queued agent');
		},
	});
}
