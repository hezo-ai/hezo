import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface QueuedWakeup {
	id: string;
	member_id: string;
	member_name: string;
	source: string;
	created_at: string;
	coalesced_count: number;
	last_skipped_reason: string | null;
	/** This agent already has an active run on another task in the same project. */
	agent_busy: boolean;
	/** Set when the wakeup's source is gated and the task has open dependency blockers. */
	run_now_blocked: 'blocked_by_dependency' | null;
}

/** Live "can this task accept a run now" state, shared by every queued wakeup on the task. */
export interface QueuedDispatchState {
	task_busy: boolean;
	instance_at_capacity: boolean;
}

export interface QueuedWakeupsState {
	wakeups: QueuedWakeup[];
	dispatch: QueuedDispatchState;
}

export function useQueuedWakeups(projectId: string, taskId: string) {
	return useQuery({
		queryKey: queryKeys.projects.taskQueuedWakeups(projectId, taskId),
		queryFn: () =>
			api.get<QueuedWakeupsState>(`/api/projects/${projectId}/tasks/${taskId}/queued-wakeups`),
		refetchInterval: 5_000,
	});
}
