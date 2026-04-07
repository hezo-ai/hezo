import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface AiProviderConfig {
	id: string;
	provider: string;
	auth_method: string;
	label: string;
	is_default: boolean;
	status: string;
	metadata: Record<string, unknown>;
	created_at: string;
}

export interface AiProviderStatus {
	configured: boolean;
	providers: string[];
}

export function useAiProviders(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'ai-providers'],
		queryFn: () => api.get<AiProviderConfig[]>(`/api/companies/${companyId}/ai-providers`),
	});
}

export function useAiProviderStatus(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'ai-providers', 'status'],
		queryFn: () => api.get<AiProviderStatus>(`/api/companies/${companyId}/ai-providers/status`),
	});
}

export function useCreateAiProvider(companyId: string) {
	return useMutation({
		mutationFn: (data: {
			provider: string;
			api_key: string;
			label?: string;
			auth_method?: string;
		}) => api.post<AiProviderConfig>(`/api/companies/${companyId}/ai-providers`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'ai-providers'] }),
	});
}

export function useDeleteAiProvider(companyId: string) {
	return useMutation({
		mutationFn: (configId: string) =>
			api.delete(`/api/companies/${companyId}/ai-providers/${configId}`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'ai-providers'] }),
	});
}

export function useSetDefaultAiProvider(companyId: string) {
	return useMutation({
		mutationFn: (configId: string) =>
			api.patch(`/api/companies/${companyId}/ai-providers/${configId}/default`, {}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'ai-providers'] }),
	});
}

export function useVerifyAiProvider(companyId: string) {
	return useMutation({
		mutationFn: (configId: string) =>
			api.post<{ valid: boolean; error?: string }>(
				`/api/companies/${companyId}/ai-providers/${configId}/verify`,
			),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'ai-providers'] }),
	});
}

export function useStartAiProviderOAuth(companyId: string) {
	return useMutation({
		mutationFn: (provider: string) =>
			api.post<{ auth_url: string; state: string }>(
				`/api/companies/${companyId}/ai-providers/${provider}/oauth/start`,
			),
	});
}
