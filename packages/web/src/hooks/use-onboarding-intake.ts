import { useMutation, useQuery } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface OnboardingIntake {
	task_id: string;
	task_identifier: string;
	project_slug: string;
	captain_greeting: string;
	captain_member_id: string;
	captain_title: string;
}

export interface UseOnboardingIntakeOptions {
	/** When true, creates the intake task if missing. */
	ensure?: boolean;
}

export function useOnboardingIntake(
	projectId: string,
	enabled = true,
	options: UseOnboardingIntakeOptions = {},
) {
	const ensure = options.ensure ?? false;
	return useQuery({
		queryKey: ['projects', projectId, 'onboarding-intake', ensure],
		queryFn: async (): Promise<OnboardingIntake | null> => {
			try {
				return await api.get<OnboardingIntake>(`/api/projects/${projectId}/onboarding-intake`, {
					ensure: ensure ? 'true' : undefined,
				});
			} catch (e) {
				const err = e as ApiError;
				if (!ensure && err.status === 404) return null;
				throw e;
			}
		},
		enabled: enabled && !!projectId,
		staleTime: 30_000,
		refetchOnMount: 'always',
	});
}

export function useStartOnboardingIntake(projectId: string) {
	return useMutation({
		mutationFn: () =>
			api.get<OnboardingIntake>(`/api/projects/${projectId}/onboarding-intake`, { ensure: 'true' }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'onboarding-intake'] });
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'onboarding'] });
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'tasks'] });
		},
	});
}

export function useSkipOnboardingQuestions(projectId: string) {
	return useMutation({
		mutationFn: () =>
			api.post<{ task_id: string; comment_id: string }>(
				`/api/projects/${projectId}/onboarding-intake/skip-questions`,
			),
		onSuccess: (data) => {
			queryClient.invalidateQueries({
				queryKey: ['projects', projectId, 'tasks', data.task_id, 'comments'],
			});
		},
	});
}
