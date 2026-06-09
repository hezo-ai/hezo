import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import type { HeartbeatRun } from './use-heartbeat-runs';
import { toast } from './use-toast';

interface TerminateRunArgs {
	projectId: string;
	agentId: string;
	runId: string;
	taskId?: string | null;
}

export function useTerminateRun({ projectId, agentId, runId, taskId }: TerminateRunArgs) {
	return useMutation({
		mutationFn: () =>
			api.post<HeartbeatRun & { terminated: boolean }>(
				`/api/projects/${projectId}/agents/${agentId}/heartbeat-runs/${runId}/terminate`,
				{},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.agentHeartbeatRuns(projectId, agentId),
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.agentHeartbeatRun(projectId, agentId, runId),
			});
			if (taskId) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.projects.taskComments(projectId, taskId),
				});
			}
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to terminate run');
		},
	});
}
