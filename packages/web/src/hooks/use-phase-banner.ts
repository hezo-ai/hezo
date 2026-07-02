import type { ProjectTaskListPhaseBanner } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

interface PhaseBannerState {
	phase_banner: ProjectTaskListPhaseBanner | null;
}

export function usePhaseBanner(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.tasksPhaseBanner(projectId),
		queryFn: () => api.get<PhaseBannerState>(`/api/projects/${projectId}/tasks/phase-banner`),
	});
}
