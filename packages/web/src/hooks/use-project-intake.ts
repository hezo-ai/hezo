import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

// `intakeTaskId` is the route-param slug — it must match the key used by
// `useComments(teamId, taskId)` so the optimistic invalidation actually refetches.
// The server route accepts both slugs and UUIDs (resolveTaskId).
export function useSkipProjectIntakeQuestions(teamId: string, intakeTaskId: string) {
	return useMutation({
		mutationFn: () =>
			api.post<{ task_id: string; comment_id: string }>(
				`/api/teams/${teamId}/project-intake/${intakeTaskId}/skip-questions`,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', intakeTaskId, 'comments'],
			});
		},
	});
}
