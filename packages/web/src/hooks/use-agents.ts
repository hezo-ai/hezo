import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Agent {
	id: string;
	company_id: string;
	display_name: string;
	title: string;
	slug: string;
	role_description: string | null;
	system_prompt: string | null;
	runtime_type: string;
	heartbeat_interval_min: number;
	monthly_budget_cents: number;
	budget_used_cents: number;
	budget_reset_at: string | null;
	status: string;
	last_heartbeat_at: string | null;
	reports_to: string | null;
	reports_to_title: string | null;
	assigned_issue_count: number;
	created_at: string;
}

export function useAgents(companyId: string, status?: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'agents', { status }],
		queryFn: () =>
			api.get<Agent[]>(`/api/companies/${companyId}/agents`, status ? { status } : undefined),
	});
}

export function useAgent(companyId: string, agentId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'agents', agentId],
		queryFn: () => api.get<Agent>(`/api/companies/${companyId}/agents/${agentId}`),
	});
}

export function useCreateAgent(companyId: string) {
	return useMutation({
		mutationFn: (data: {
			title: string;
			role_description?: string;
			system_prompt?: string;
			reports_to?: string;
			runtime_type?: string;
			monthly_budget_cents?: number;
			heartbeat_interval_min?: number;
		}) => api.post<Agent>(`/api/companies/${companyId}/agents`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'agents'] }),
	});
}

export function useUpdateAgent(companyId: string, agentId: string) {
	return useMutation({
		mutationFn: (data: {
			title?: string;
			role_description?: string;
			system_prompt?: string;
			reports_to?: string | null;
			monthly_budget_cents?: number;
			heartbeat_interval_min?: number;
		}) => api.patch<Agent>(`/api/companies/${companyId}/agents/${agentId}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'agents'] });
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'agents', agentId] });
		},
	});
}

export function usePauseAgent(companyId: string) {
	return useMutation({
		mutationFn: (agentId: string) =>
			api.post(`/api/companies/${companyId}/agents/${agentId}/pause`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'agents'] }),
	});
}

export function useResumeAgent(companyId: string) {
	return useMutation({
		mutationFn: (agentId: string) =>
			api.post(`/api/companies/${companyId}/agents/${agentId}/resume`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'agents'] }),
	});
}

export function useTerminateAgent(companyId: string) {
	return useMutation({
		mutationFn: (agentId: string) =>
			api.post(`/api/companies/${companyId}/agents/${agentId}/terminate`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'agents'] }),
	});
}
