import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export type OnboardingStageKey = 'intake' | 'done';
export type OnboardingStageStatus = 'complete' | 'current' | 'pending';

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
	planning_task_id: string | null;
	planning_task_identifier: string | null;
	planning_task_title: string | null;
	execution_started_at: string | null;
}

export interface OnboardingStatus {
	show_welcome: boolean;
	current_stage: OnboardingStageKey;
	stages: Record<OnboardingStageKey, OnboardingStageStatus>;
	primary_project: OnboardingPrimaryProject | null;
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
