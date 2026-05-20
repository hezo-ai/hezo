import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export type OnboardingStageKey = 'requirements' | 'hire_team' | 'start_project';
export type OnboardingStageStatus = 'complete' | 'current' | 'pending';

export interface OnboardingAgentSummary {
	title: string;
	slug: string;
}

export interface OnboardingGoalSummary {
	id: string;
	title: string;
	status: string;
}

export interface OnboardingPrimaryProject {
	id: string;
	slug: string;
	name: string;
	description: string;
	planning_issue_id: string | null;
	planning_issue_identifier: string | null;
	planning_issue_title: string | null;
	execution_started_at: string | null;
}

export interface OnboardingStatus {
	show_welcome: boolean;
	current_stage: OnboardingStageKey;
	stages: Record<OnboardingStageKey, OnboardingStageStatus>;
	primary_project: OnboardingPrimaryProject | null;
	agents: OnboardingAgentSummary[];
	goals: OnboardingGoalSummary[];
}

export function useOnboarding(teamId: string, enabled = true) {
	return useQuery({
		queryKey: ['teams', teamId, 'onboarding'],
		queryFn: () => api.get<OnboardingStatus>(`/api/teams/${teamId}/onboarding`),
		enabled: enabled && !!teamId,
		staleTime: 10_000,
	});
}

export function useConfirmProjectStart(teamId: string) {
	return useMutation({
		mutationFn: () =>
			api.post<{ project: OnboardingPrimaryProject }>(
				`/api/teams/${teamId}/onboarding/start-project`,
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'onboarding'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'projects'] });
		},
	});
}
