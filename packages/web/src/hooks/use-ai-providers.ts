import type { AiProviderModel } from '@hezo/shared';
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
	default_model: string | null;
	metadata: Record<string, unknown>;
	created_at: string;
}

export interface AiProviderStatus {
	configured: boolean;
	providers: string[];
}

const providersKey = ['ai-providers'] as const;
const statusKey = ['ai-providers', 'status'] as const;

function invalidateAll() {
	queryClient.invalidateQueries({ queryKey: providersKey });
	queryClient.invalidateQueries({ queryKey: statusKey });
}

export function useAiProviders() {
	return useQuery({
		queryKey: providersKey,
		queryFn: () => api.get<AiProviderConfig[]>('/api/ai-providers'),
	});
}

export function useAiProviderStatus(options: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: statusKey,
		queryFn: () => api.get<AiProviderStatus>('/api/ai-providers/status'),
		enabled: options.enabled ?? true,
	});
}

export function useCreateAiProvider() {
	return useMutation({
		mutationFn: (data: {
			provider: string;
			api_key: string;
			label?: string;
			auth_method?: string;
		}) => api.post<AiProviderConfig>('/api/ai-providers', data),
		onSuccess: invalidateAll,
	});
}

export function useDeleteAiProvider() {
	return useMutation({
		mutationFn: (configId: string) => api.delete(`/api/ai-providers/${configId}`),
		onSuccess: invalidateAll,
	});
}

export function useSetDefaultAiProvider() {
	return useMutation({
		mutationFn: (configId: string) => api.patch(`/api/ai-providers/${configId}/default`, {}),
		onSuccess: invalidateAll,
	});
}

export function useVerifyAiProvider() {
	return useMutation({
		mutationFn: (configId: string) =>
			api.post<{ valid: boolean; error?: string }>(`/api/ai-providers/${configId}/verify`),
		onSuccess: invalidateAll,
	});
}

export function useAiProviderModels(configId: string, options: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: ['ai-providers', configId, 'models'] as const,
		queryFn: () => api.get<AiProviderModel[]>(`/api/ai-providers/${configId}/models`),
		enabled: options.enabled ?? true,
		staleTime: 5 * 60 * 1000,
	});
}

export function useUpdateAiProviderConfig(configId: string) {
	return useMutation({
		mutationFn: (data: { default_model: string | null }) =>
			api.patch<{ updated: boolean; default_model: string | null }>(
				`/api/ai-providers/${configId}`,
				data,
			),
		onSuccess: invalidateAll,
	});
}
