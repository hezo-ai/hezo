import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export interface Skill {
	id: string;
	team_id: string;
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

export function useSkills(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'skills'],
		queryFn: () => api.get<Skill[]>(`/api/teams/${teamId}/skills`),
	});
}

export function useSkillDetail(teamId: string, slug: string | null) {
	return useQuery({
		queryKey: ['teams', teamId, 'skills', slug],
		queryFn: () => api.get<SkillDetail>(`/api/teams/${teamId}/skills/${slug}`),
		enabled: slug !== null,
	});
}

export function useCreateSkill(teamId: string) {
	return useMutation({
		mutationFn: (data: {
			name: string;
			source_url: string;
			description?: string;
			tags?: string[];
		}) => api.post<SkillDetail>(`/api/teams/${teamId}/skills`, data),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'skills'] }),
	});
}

export function useSyncSkill(teamId: string) {
	return useMutation({
		mutationFn: (slug: string) =>
			api.post<SkillDetail>(`/api/teams/${teamId}/skills/${slug}/sync`, {}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'skills'] }),
	});
}

export function useDeleteSkill(teamId: string) {
	return useMutation({
		mutationFn: (slug: string) => api.delete(`/api/teams/${teamId}/skills/${slug}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'skills'] }),
	});
}
