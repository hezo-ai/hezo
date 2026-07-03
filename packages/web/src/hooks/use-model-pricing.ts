import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

// Runtime model pricing is instance-global: per-model token rates used to
// compute run cost across every team. The Admin (superuser) edits manual
// overrides; the rest refreshes from the pricepertoken.com catalog. Mutations
// invalidate + refetch (no optimism — the server validates/normalizes).
export const MODEL_PRICING_KEY = ['instance', 'model-pricing'] as const;

export interface ModelPricingRow {
	id: string;
	model_id: string;
	input_per_token: number;
	output_per_token: number;
	cache_read_per_token: number | null;
	cache_creation_per_token: number | null;
	source: 'pricepertoken' | 'manual';
	updated_at: string;
}

export interface CreateOverridePayload {
	model_id: string;
	input_per_token: number;
	output_per_token: number;
	cache_read_per_token?: number | null;
	cache_creation_per_token?: number | null;
}

export function useModelPricing() {
	return useQuery({
		queryKey: MODEL_PRICING_KEY,
		queryFn: () => api.get<ModelPricingRow[]>('/api/model-pricing'),
	});
}

export function useCreateModelPricingOverride() {
	return useMutation({
		mutationFn: (data: CreateOverridePayload) =>
			api.post<ModelPricingRow>('/api/model-pricing', data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: MODEL_PRICING_KEY }),
	});
}

export function useDeleteModelPricingOverride() {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/model-pricing/${id}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: MODEL_PRICING_KEY }),
	});
}

export function useRefreshModelPricing() {
	return useMutation({
		mutationFn: () => api.post<{ refreshed: number }>('/api/model-pricing/refresh'),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: MODEL_PRICING_KEY }),
	});
}
