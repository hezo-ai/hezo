import { useQuery } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';

export interface HireTeamIntake {
	issue_id: string;
	issue_identifier: string;
	project_slug: string;
	captain_greeting: string;
	captain_member_id: string;
	captain_title: string;
}

export function useHireTeamIntake(teamId: string, enabled = true) {
	return useQuery({
		queryKey: ['teams', teamId, 'hire-team-intake'],
		queryFn: async (): Promise<HireTeamIntake | null> => {
			try {
				return await api.get<HireTeamIntake>(`/api/teams/${teamId}/hire-team-intake`);
			} catch (e) {
				const err = e as ApiError;
				if (err.status === 404) return null;
				throw e;
			}
		},
		enabled: enabled && !!teamId,
		staleTime: 30_000,
		refetchOnMount: 'always',
	});
}
