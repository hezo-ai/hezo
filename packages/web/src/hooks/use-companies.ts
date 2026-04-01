import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Company {
	id: string;
	name: string;
	mission: string | null;
	issue_prefix: string;
	email: string | null;
	company_type_id: string | null;
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

export function useCompany(id: string) {
	return useQuery({
		queryKey: ['companies', id],
		queryFn: () => api.get<Company>(`/api/companies/${id}`),
	});
}

export function useCreateCompany() {
	return useMutation({
		mutationFn: (data: {
			name: string;
			mission?: string;
			company_type_id?: string;
			email?: string;
			issue_prefix?: string;
		}) => api.post<Company>('/api/companies', data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['companies'] }),
	});
}

export function useUpdateCompany(id: string) {
	return useMutation({
		mutationFn: (data: { name?: string; mission?: string; email?: string }) =>
			api.patch<Company>(`/api/companies/${id}`, data),
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
