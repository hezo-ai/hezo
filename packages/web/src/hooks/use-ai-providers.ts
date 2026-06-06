import type { AiProviderModel } from '@hezo/shared';
import { type QueryKey, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useInvalidatingMutation } from './use-invalidating-mutation';

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

// Provider changes ripple into the status pill and every team's runtime config,
// so all three lists refetch. AI-provider mutations are validation-heavy /
// security-sensitive (api_key verify), so they invalidate rather than predict.
const allKeys: QueryKey[] = [providersKey, statusKey, ['teams']];

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
	return useInvalidatingMutation<
		{ provider: string; api_key: string; label?: string; auth_method?: string },
		AiProviderConfig
	>({
		mutationFn: (data) => api.post<AiProviderConfig>('/api/ai-providers', data),
		invalidate: allKeys,
	});
}

export function useDeleteAiProvider() {
	return useInvalidatingMutation<string, unknown>({
		mutationFn: (configId) => api.delete(`/api/ai-providers/${configId}`),
		invalidate: allKeys,
	});
}

export function useSetDefaultAiProvider() {
	return useInvalidatingMutation<string, unknown>({
		mutationFn: (configId) => api.patch(`/api/ai-providers/${configId}/default`, {}),
		invalidate: allKeys,
	});
}

export function useVerifyAiProvider() {
	return useInvalidatingMutation<string, { valid: boolean; error?: string }>({
		mutationFn: (configId) =>
			api.post<{ valid: boolean; error?: string }>(`/api/ai-providers/${configId}/verify`),
		invalidate: allKeys,
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
	return useInvalidatingMutation<
		{ default_model: string | null },
		{ updated: boolean; default_model: string | null }
	>({
		mutationFn: (data) =>
			api.patch<{ updated: boolean; default_model: string | null }>(
				`/api/ai-providers/${configId}`,
				data,
			),
		invalidate: allKeys,
	});
}
