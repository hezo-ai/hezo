import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

function invalidateProject(teamId: string, projectId: string) {
	queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'projects'] });
	queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'projects', projectId] });
}

export function useStartContainer(teamId: string, projectId: string) {
	return useMutation({
		mutationFn: () => api.post(`/api/teams/${teamId}/projects/${projectId}/container/start`, {}),
		onSuccess: () => invalidateProject(teamId, projectId),
	});
}

export function useStopContainer(teamId: string, projectId: string) {
	return useMutation({
		mutationFn: () => api.post(`/api/teams/${teamId}/projects/${projectId}/container/stop`, {}),
		onSuccess: () => invalidateProject(teamId, projectId),
	});
}

export function useRebuildContainer(teamId: string, projectId: string) {
	return useMutation({
		mutationFn: () => api.post(`/api/teams/${teamId}/projects/${projectId}/container/rebuild`, {}),
		onSuccess: () => invalidateProject(teamId, projectId),
	});
}
