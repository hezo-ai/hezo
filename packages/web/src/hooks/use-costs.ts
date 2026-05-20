import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface CostSummary {
	summary?: Array<{ label: string; total_cents: number }>;
	entries?: Array<{
		id: string;
		amount_cents: number;
		description: string | null;
		created_at: string;
		member_name: string;
	}>;
	total_cents: number;
}

export function useCosts(
	teamId: string,
	params?: { group_by?: string; agent_id?: string; project_id?: string },
) {
	return useQuery({
		queryKey: ['teams', teamId, 'costs', params],
		queryFn: () =>
			api.get<CostSummary>(`/api/teams/${teamId}/costs`, params as Record<string, string>),
	});
}
