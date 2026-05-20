import { useQuery } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';

export interface RequirementsIntake {
	issue_id: string;
	issue_identifier: string;
	project_slug: string;
	captain_greeting: string;
	captain_member_id: string;
	captain_title: string;
}

export interface UseRequirementsIntakeOptions {
	/** When true, creates the intake issue if missing (use before any user-facing project exists). */
	ensure?: boolean;
}

export function useRequirementsIntake(
	teamId: string,
	enabled = true,
	options: UseRequirementsIntakeOptions = {},
) {
	const ensure = options.ensure ?? false;
	return useQuery({
		queryKey: ['teams', teamId, 'requirements-intake', ensure],
		queryFn: async (): Promise<RequirementsIntake | null> => {
			try {
				return await api.get<RequirementsIntake>(`/api/teams/${teamId}/requirements-intake`, {
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
