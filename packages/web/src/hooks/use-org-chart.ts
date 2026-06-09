import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface OrgNode {
	id: string;
	title: string;
	slug: string;
	role_description: string;
	runtime_status: string;
	admin_status: string;
	reports_to: string | null;
	children: OrgNode[];
}

export interface OrgChart {
	admin: { children: OrgNode[] };
}

export function useOrgChart(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.orgChart(projectId),
		queryFn: () => api.get<OrgChart>(`/api/projects/${projectId}/org-chart`),
	});
}
