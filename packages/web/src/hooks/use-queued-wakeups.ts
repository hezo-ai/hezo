import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface QueuedWakeup {
	id: string;
	member_id: string;
	member_name: string;
	source: string;
	created_at: string;
	coalesced_count: number;
	last_skipped_reason: string | null;
}

export interface QueuedWakeupsState {
	wakeups: QueuedWakeup[];
}

export function useQueuedWakeups(teamId: string, taskId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'tasks', taskId, 'queued-wakeups'],
		queryFn: () =>
			api.get<QueuedWakeupsState>(`/api/teams/${teamId}/tasks/${taskId}/queued-wakeups`),
		refetchInterval: 5_000,
	});
}
