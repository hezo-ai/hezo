import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { ManualDispatchResult } from '../lib/manual-dispatch';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useManualDispatchNotice } from './use-manual-dispatch-notice';
import { toast } from './use-toast';

interface RetryFailedRunArgs {
	projectId: string;
	taskId: string;
}

export function useRetryFailedRun({ projectId, taskId }: RetryFailedRunArgs) {
	const announce = useManualDispatchNotice();
	return useMutation({
		mutationFn: (runId: string) =>
			api.post<ManualDispatchResult>(
				`/api/projects/${projectId}/tasks/${taskId}/runs/${runId}/retry`,
				{},
			),
		onSuccess: (data) => {
			// A retry the instance could not start immediately is queued, not lost -
			// a neutral notice, never the error toast, which said the run had failed
			// while it was on its way. The invalidations run either way so the
			// queued-agents row appears with the notice rather than at the next poll.
			announce(data);
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
