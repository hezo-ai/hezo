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

export function useOrgChart(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'org-chart'],
		queryFn: () => api.get<OrgChart>(`/api/companies/${companyId}/org-chart`),
	});
}
