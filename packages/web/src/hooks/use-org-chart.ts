import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface OrgNode {
	id: string;
	title: string;
	slug: string;
	runtime_status: string;
	admin_status: string;
	reports_to: string | null;
	children: OrgNode[];
}

export interface OrgChart {
	board: { children: OrgNode[] };
}

export function useOrgChart(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'org-chart'],
		queryFn: () => api.get<OrgChart>(`/api/teams/${teamId}/org-chart`),
	});
}
