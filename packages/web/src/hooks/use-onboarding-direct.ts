import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface OnboardingDirectInput {
	template_id: string;
	project_name: string;
	project_description?: string;
	initial_prd?: string;
}

export interface OnboardingDirectResult {
	// The first project gets its own team (projects-primary); navigate using it.
	team_id: string;
	team_slug: string;
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
