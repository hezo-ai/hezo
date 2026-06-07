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

export function useSkills(projectId: string) {
	return useQuery({
		queryKey: ['projects', projectId, 'skills'],
		queryFn: () => api.get<SkillListItem[]>(`/api/projects/${projectId}/skills`),
		enabled: !!projectId,
	});
}

export function useSkill(projectId: string, slug: string | null) {
	return useQuery({
		queryKey: ['projects', projectId, 'skills', slug],
		queryFn: () => api.get<Skill>(`/api/projects/${projectId}/skills/${slug}`),
		enabled: !!projectId && slug !== null,
	});
}

export function useCreateSkill(projectId: string) {
	return useMutation({
		mutationFn: (input: CreateSkillInput) =>
			api.post<Skill>(`/api/projects/${projectId}/skills`, input),
		onSuccess: (created) => {
			queryClient.setQueryData<Skill>(['projects', projectId, 'skills', created.slug], created);
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'skills'] });
		},
	});
}

export function useUpdateSkill(projectId: string) {
	return useMutation({
		mutationFn: ({ slug, input }: { slug: string; input: UpdateSkillInput }) =>
			api.patch<Skill>(`/api/projects/${projectId}/skills/${slug}`, input),
		onSuccess: (updated, { slug }) => {
			queryClient.setQueryData<Skill>(['projects', projectId, 'skills', slug], updated);
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'skills'] });
		},
	});
}

export function useSyncSkill(projectId: string) {
	return useMutation({
		mutationFn: (slug: string) =>
			api.post<Skill>(`/api/projects/${projectId}/skills/${slug}/sync`, {}),
		onSuccess: (updated, slug) => {
			queryClient.setQueryData<Skill>(['projects', projectId, 'skills', slug], updated);
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'skills'] });
		},
	});
}

export function useDeleteSkill(projectId: string) {
	return useMutation({
		mutationFn: (slug: string) => api.delete(`/api/projects/${projectId}/skills/${slug}`),
		onSuccess: (_, slug) => {
			queryClient.removeQueries({ queryKey: ['projects', projectId, 'skills', slug] });
			queryClient.invalidateQueries({ queryKey: ['projects', projectId, 'skills'] });
		},
	});
}
