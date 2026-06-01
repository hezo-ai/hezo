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
	/** Set when the wakeup's source is gated and the task has open dependency blockers. */
	run_now_blocked: 'blocked_by_dependency' | null;
}

/** Live "can this task accept a run now" state, shared by every queued wakeup on the task. */
export interface QueuedDispatchState {
	task_busy: boolean;
	project_at_capacity: boolean;
}

export interface QueuedWakeupsState {
	wakeups: QueuedWakeup[];
	dispatch: QueuedDispatchState;
}

export function useQueuedWakeups(teamId: string, taskId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'tasks', taskId, 'queued-wakeups'],
		queryFn: () =>
			api.get<QueuedWakeupsState>(`/api/teams/${teamId}/tasks/${taskId}/queued-wakeups`),
		refetchInterval: 5_000,
	});
}
