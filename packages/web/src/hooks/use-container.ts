import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

function invalidateProject(projectId: string) {
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
}

export function useStartContainer(projectId: string) {
	return useMutation({
		mutationFn: () => api.post(`/api/projects/${projectId}/container/start`, {}),
		onSuccess: () => invalidateProject(projectId),
	});
}

export function useStopContainer(projectId: string) {
	return useMutation({
		mutationFn: () => api.post(`/api/projects/${projectId}/container/stop`, {}),
		onSuccess: () => invalidateProject(projectId),
	});
}

export function useRebuildContainer(projectId: string) {
	return useMutation({
		mutationFn: () => api.post(`/api/projects/${projectId}/container/rebuild`, {}),
		onSuccess: () => invalidateProject(projectId),
	});
}
