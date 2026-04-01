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
	companyId: string,
	params?: { group_by?: string; agent_id?: string; project_id?: string },
) {
	return useQuery({
		queryKey: ['companies', companyId, 'costs', params],
		queryFn: () =>
			api.get<CostSummary>(`/api/companies/${companyId}/costs`, params as Record<string, string>),
	});
}
