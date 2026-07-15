import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface ProjectIntake {
	task_id: string;
	task_identifier: string;
	/** The HQ project slug — where the intake conversation lives. */
	project_slug: string;
	greeting: string;
	ceo_member_id: string;
	ceo_title: string;
}

export interface StartProjectIntakeInput {
	name: string;
	description: string;
	template_id?: string;
	source_team_id?: string;
	marketplace_slug?: string;
	task_prefix?: string;
	initial_project_plan?: string;
}

export interface StartProjectIntakeResult {
	intake_task_id: string;
	intake_task_identifier: string;
	/** The HQ project slug — where the intake conversation lives. */
	project_slug: string;
}

/** The single open CEO-assisted project intake, or null. Surfaced on the home view. */
export function useProjectIntake(enabled = true) {
	return useQuery({
		queryKey: queryKeys.projectIntakes(),
		queryFn: () => api.get<ProjectIntake | null>('/api/project-intakes'),
		enabled,
		staleTime: 30_000,
		refetchOnMount: 'always',
	});
}

/** Opens a CEO-assisted project intake: stands up the team and the HQ conversation. */
export function useStartProjectIntake() {
	return useMutation({
		mutationFn: (input: StartProjectIntakeInput) =>
			api.post<StartProjectIntakeResult>('/api/project-intakes', input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projectIntakes() });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
			// Cloning a team mints a new reusable template — refresh the catalog.
			queryClient.invalidateQueries({ queryKey: queryKeys.teamTemplates() });
		},
	});
}
