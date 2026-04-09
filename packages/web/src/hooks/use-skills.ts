import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Skill {
	id: string;
	company_id: string;
	name: string;
	slug: string;
	description: string;
	source_url: string | null;
	content_hash: string;
	created_by_member_id: string | null;
	tags: string[];
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export interface SkillDetail extends Skill {
	content: string;
}

export function useSkills(companyId: string) {
	return useQuery({
		queryKey: ['companies', companyId, 'skills'],
		queryFn: () => api.get<Skill[]>(`/api/companies/${companyId}/skills`),
	});
}

export function useSkillDetail(companyId: string, slug: string | null) {
	return useQuery({
		queryKey: ['companies', companyId, 'skills', slug],
		queryFn: () => api.get<SkillDetail>(`/api/companies/${companyId}/skills/${slug}`),
		enabled: slug !== null,
	});
}

export function useCreateSkill(companyId: string) {
	return useMutation({
		mutationFn: (data: {
			name: string;
			source_url: string;
			description?: string;
			tags?: string[];
		}) => api.post<SkillDetail>(`/api/companies/${companyId}/skills`, data),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'skills'] }),
	});
}

export function useSyncSkill(companyId: string) {
	return useMutation({
		mutationFn: (slug: string) =>
			api.post<SkillDetail>(`/api/companies/${companyId}/skills/${slug}/sync`, {}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'skills'] }),
	});
}

export function useDeleteSkill(companyId: string) {
	return useMutation({
		mutationFn: (slug: string) => api.delete(`/api/companies/${companyId}/skills/${slug}`),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ['companies', companyId, 'skills'] }),
	});
}
