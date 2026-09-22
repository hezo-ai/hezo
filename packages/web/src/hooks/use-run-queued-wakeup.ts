import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { type ManualDispatchResult, manualDispatchNoticeKey } from '../lib/manual-dispatch';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { toast } from './use-toast';

interface RunQueuedWakeupArgs {
	projectId: string;
	taskId: string;
}

export function useRunQueuedWakeup({ projectId, taskId }: RunQueuedWakeupArgs) {
	const { t } = useI18n();
	return useMutation({
		mutationFn: (wakeupId: string) =>
			api.post<ManualDispatchResult>(
				`/api/projects/${projectId}/tasks/${taskId}/queued-wakeups/${wakeupId}/run-now`,
				{},
			),
		onSuccess: (data) => {
			// Not started: either a wait (the row is still queued) or a hold the
			// presser cannot lift. Say which it is.
			const notice = manualDispatchNoticeKey(data);
			if (notice) toast.info(t(notice));
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskQueuedWakeups(projectId, taskId),
			});
			// Surface the system comment recording the manual start.
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			});
			// Refresh the single queued_wakeup badge / has_active_run on the task.
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.task(projectId, taskId) });
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to start queued agent');
		},
	});
}
