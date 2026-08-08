import type { AgentRuntime, AiProviderModel } from '@hezo/shared';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export interface AiProviderConfig {
	id: string;
	provider: string;
	auth_method: string;
	label: string;
	is_default: boolean;
	status: string;
	default_model: string | null;
	metadata: Record<string, unknown>;
	/**
	 * The CLI this credential runs on, or null to follow the provider default.
	 * Resolve it with `effectiveRuntime` before displaying — null is the common
	 * case and still means a concrete runtime.
	 */
	runtime: AgentRuntime | null;
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
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.all() });
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
			/** Locally-hosted providers only (Ollama, LM Studio): the operator's server URL. */
			base_url?: string;
			/** Chosen CLI. Omit (or null) to follow the provider default. */
			runtime?: AgentRuntime | null;
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
		// The server returns `{ valid, message }` on failure; `error` is kept for
		// back-compat with any caller still reading it.
		mutationFn: (configId: string) =>
			api.post<{ valid: boolean; message?: string; error?: string }>(
				`/api/ai-providers/${configId}/verify`,
			),
		onSuccess: invalidateAll,
	});
}

export function useAiProviderModels(configId: string, options: { enabled?: boolean } = {}) {
	return useQuery({
		queryKey: queryKeys.aiProviderModels(configId),
		queryFn: () => api.get<AiProviderModel[]>(`/api/ai-providers/${configId}/models`),
		enabled: options.enabled ?? true,
		staleTime: 5 * 60 * 1000,
	});
}

/**
 * Aggregate the live model catalogs across several provider configs, deduped by
 * model id. Used to offer dynamic suggestions where a single config isn't the
 * subject (e.g. the pricing-override model-id field). Each config fetches through
 * the same per-config query as `useAiProviderModels`, so the cache is shared.
 */
export function useAllProviderModels(
	configIds: string[],
	options: { enabled?: boolean } = {},
): { models: AiProviderModel[]; isLoading: boolean } {
	const enabled = options.enabled ?? true;
	const results = useQueries({
		queries: configIds.map((configId) => ({
			queryKey: queryKeys.aiProviderModels(configId),
			queryFn: () => api.get<AiProviderModel[]>(`/api/ai-providers/${configId}/models`),
			enabled,
			staleTime: 5 * 60 * 1000,
		})),
	});

	const byId = new Map<string, AiProviderModel>();
	for (const r of results) {
		for (const m of r.data ?? []) {
			if (!byId.has(m.id)) byId.set(m.id, m);
		}
	}

	return {
		models: Array.from(byId.values()),
		isLoading: results.some((r) => r.isLoading),
	};
}

export function useUpdateAiProviderConfig(configId: string) {
	return useMutation({
		mutationFn: (data: {
			default_model?: string | null;
			label?: string;
			runtime?: AgentRuntime | null;
		}) =>
			api.patch<{
				updated: boolean;
				default_model?: string | null;
				label?: string;
				runtime?: AgentRuntime | null;
			}>(`/api/ai-providers/${configId}`, data),
		onSuccess: invalidateAll,
	});
}
