import type { TaskProgressSummary } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export function useTaskProgressSummary(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.tasksProgressSummary(projectId),
		queryFn: () =>
			api.get<TaskProgressSummary>(`/api/projects/${projectId}/tasks/progress-summary`),
	});
}
