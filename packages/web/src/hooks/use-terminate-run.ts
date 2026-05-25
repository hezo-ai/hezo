import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import type { HeartbeatRun } from './use-heartbeat-runs';
import { toast } from './use-toast';

interface TerminateRunArgs {
	teamId: string;
	agentId: string;
	runId: string;
	taskId?: string | null;
}

export function useTerminateRun({ teamId, agentId, runId, taskId }: TerminateRunArgs) {
	return useMutation({
		mutationFn: () =>
			api.post<HeartbeatRun & { terminated: boolean }>(
				`/api/teams/${teamId}/agents/${agentId}/heartbeat-runs/${runId}/terminate`,
				{},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'agents', agentId, 'heartbeat-runs'],
			});
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'agents', agentId, 'heartbeat-runs', runId],
			});
			if (taskId) {
				queryClient.invalidateQueries({
					queryKey: ['teams', teamId, 'tasks', taskId, 'comments'],
				});
			}
		},
		onError: (error: { message?: string }) => {
			toast.error(error?.message ?? 'Failed to terminate run');
		},
	});
}
