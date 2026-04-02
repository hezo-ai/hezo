import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

function invalidateProject(companyId: string, projectId: string) {
	queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects'] });
	queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'projects', projectId] });
}

export function useStartContainer(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: () =>
			api.post(`/api/companies/${companyId}/projects/${projectId}/container/start`, {}),
		onSuccess: () => invalidateProject(companyId, projectId),
	});
}

export function useStopContainer(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: () =>
			api.post(`/api/companies/${companyId}/projects/${projectId}/container/stop`, {}),
		onSuccess: () => invalidateProject(companyId, projectId),
	});
}

export function useRebuildContainer(companyId: string, projectId: string) {
	return useMutation({
		mutationFn: () =>
			api.post(`/api/companies/${companyId}/projects/${projectId}/container/rebuild`, {}),
		onSuccess: () => invalidateProject(companyId, projectId),
	});
}
