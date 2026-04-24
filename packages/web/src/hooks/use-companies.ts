import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface CompanySettings {
	wake_mentioner_on_reply?: boolean;
	[key: string]: unknown;
}

export interface Company {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	team_summary: string | null;
	team_type_ids: string[];
	mcp_servers: unknown[];
	settings: CompanySettings;
	agent_count: number;
	open_issue_count: number;
	created_at: string;
}

export function useCompanies() {
	return useQuery({
		queryKey: ['companies'],
		queryFn: () => api.get<Company[]>('/api/companies'),
	});
}

export function useCompany(id: string, enabled = true) {
	return useQuery({
		queryKey: ['companies', id],
		queryFn: () => api.get<Company>(`/api/companies/${id}`),
		enabled,
	});
}

export function useCreateCompany() {
	return useMutation({
		mutationFn: (data: { name: string; description?: string; template_id?: string }) =>
			api.post<Company>('/api/companies', data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['companies'] }),
	});
}

export function useUpdateCompany(id: string) {
	return useMutation({
		mutationFn: (data: {
			name?: string;
			description?: string;
			mcp_servers?: unknown[];
			settings?: Partial<CompanySettings>;
		}) => api.patch<Company>(`/api/companies/${id}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['companies'] });
			queryClient.invalidateQueries({ queryKey: ['companies', id] });
		},
	});
}

export function useDeleteCompany() {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/companies/${id}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['companies'] }),
	});
}
