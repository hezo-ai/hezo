import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface OnboardingDirectInput {
	template_id: string;
	project_name: string;
	project_description?: string;
}

export interface OnboardingDirectResult {
	project_id: string;
	project_slug: string;
	planning_task_id: string;
	planning_task_identifier: string;
	created_agent_slugs: string[];
}

export function useOnboardingDirect(teamId: string) {
	return useMutation({
		mutationFn: (input: OnboardingDirectInput) =>
			api.post<OnboardingDirectResult>(`/api/teams/${teamId}/onboarding/direct`, input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams'] });
			queryClient.invalidateQueries({ queryKey: ['projects'] });
			queryClient.invalidateQueries({ queryKey: ['onboarding'] });
			queryClient.invalidateQueries({ queryKey: ['team-templates'] });
		},
	});
}
