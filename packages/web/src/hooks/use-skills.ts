import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

/** Row returned by the list endpoint (no content). */
export interface SkillListItem {
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

/** Full row returned by the detail endpoint (includes content). */
export interface Skill extends SkillListItem {
	content: string;
}

export interface CreateSkillInput {
	name: string;
	description?: string;
	/** Provide content for an inline skill … */
	content?: string;
	/** … or source_url to download the skill. */
	source_url?: string;
	tags?: string[];
}

export interface UpdateSkillInput {
	name?: string;
	description?: string;
	content?: string;
	tags?: string[];
}

export function useSkills(teamId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'skills'],
		queryFn: () => api.get<SkillListItem[]>(`/api/teams/${teamId}/skills`),
		enabled: !!teamId,
	});
}

export function useSkill(teamId: string, slug: string | null) {
	return useQuery({
		queryKey: ['teams', teamId, 'skills', slug],
		queryFn: () => api.get<Skill>(`/api/teams/${teamId}/skills/${slug}`),
		enabled: !!teamId && slug !== null,
	});
}

export function useCreateSkill(teamId: string) {
	return useMutation({
		mutationFn: (input: CreateSkillInput) => api.post<Skill>(`/api/teams/${teamId}/skills`, input),
		onSuccess: (created) => {
			queryClient.setQueryData<Skill>(['teams', teamId, 'skills', created.slug], created);
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'skills'] });
		},
	});
}

export function useUpdateSkill(teamId: string) {
	return useMutation({
		mutationFn: ({ slug, input }: { slug: string; input: UpdateSkillInput }) =>
			api.patch<Skill>(`/api/teams/${teamId}/skills/${slug}`, input),
		onSuccess: (updated, { slug }) => {
			queryClient.setQueryData<Skill>(['teams', teamId, 'skills', slug], updated);
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'skills'] });
		},
	});
}

export function useSyncSkill(teamId: string) {
	return useMutation({
		mutationFn: (slug: string) => api.post<Skill>(`/api/teams/${teamId}/skills/${slug}/sync`, {}),
		onSuccess: (updated, slug) => {
			queryClient.setQueryData<Skill>(['teams', teamId, 'skills', slug], updated);
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'skills'] });
		},
	});
}

export function useDeleteSkill(teamId: string) {
	return useMutation({
		mutationFn: (slug: string) => api.delete(`/api/teams/${teamId}/skills/${slug}`),
		onSuccess: (_, slug) => {
			queryClient.removeQueries({ queryKey: ['teams', teamId, 'skills', slug] });
			queryClient.invalidateQueries({ queryKey: ['teams', teamId, 'skills'] });
		},
	});
}
