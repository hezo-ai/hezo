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
	teamId: string,
	enabled = true,
	options: UseOnboardingIntakeOptions = {},
) {
	const ensure = options.ensure ?? false;
	return useQuery({
		queryKey: ['teams', teamId, 'onboarding-intake', ensure],
		queryFn: async (): Promise<OnboardingIntake | null> => {
			try {
				return await api.get<OnboardingIntake>(`/api/teams/${teamId}/onboarding-intake`, {
					ensure: ensure ? 'true' : undefined,
				});
			} catch (e) {
				const err = e as ApiError;
				if (!ensure && err.status === 404) return null;
				throw e;
			}
		},
		enabled: enabled && !!teamId,
		staleTime: 30_000,
		refetchOnMount: 'always',
	});
}

export function useStartOnboardingIntake(teamId: string) {
	return useMutation({
		mutationFn: () =>
			api.get<OnboardingIntake>(`/api/teams/${teamId}/onboarding-intake`, { ensure: 'true' }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'onboarding-intake'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'onboarding'] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'tasks'] });
		},
	});
}

export function useSkipOnboardingQuestions(teamId: string) {
	return useMutation({
		mutationFn: () =>
			api.post<{ task_id: string; comment_id: string }>(
				`/api/teams/${teamId}/onboarding-intake/skip-questions`,
			),
		onSuccess: (data) => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'tasks', data.task_id, 'comments'],
			});
		},
	});
}
