import type { OnboardingStageKey, OnboardingStageStatus } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export type { OnboardingStageKey, OnboardingStageStatus };

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
}

export function useOnboarding(projectId: string, enabled = true) {
	return useQuery({
		queryKey: ['projects', projectId, 'onboarding'],
		queryFn: () => api.get<OnboardingStatus>(`/api/projects/${projectId}/onboarding`),
		enabled: enabled && !!projectId,
		staleTime: 10_000,
	});
}
