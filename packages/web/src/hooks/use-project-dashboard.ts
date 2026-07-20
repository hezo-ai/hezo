import type { ProjectDashboard } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export function useProjectDashboard(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.dashboard(projectId),
		queryFn: () => api.get<ProjectDashboard>(`/api/projects/${projectId}/dashboard`),
	});
}
