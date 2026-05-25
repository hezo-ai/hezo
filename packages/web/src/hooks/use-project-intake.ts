import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export function useSkipProjectIntakeQuestions(teamId: string, intakeTaskId: string) {
	return useMutation({
		mutationFn: () =>
			api.post<{ task_id: string; comment_id: string }>(
				`/api/teams/${teamId}/project-intake/${intakeTaskId}/skip-questions`,
			),
		onSuccess: (data) => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', data.task_id, 'comments'],
			});
		},
	});
}
