import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

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
		queryKey: queryKeys.projects.skills(projectId),
		queryFn: () => api.get<SkillListItem[]>(`/api/projects/${projectId}/skills`),
		enabled: !!projectId,
	});
}

export function useSkill(projectId: string, slug: string | null) {
	return useQuery({
		queryKey: queryKeys.projects.skill(projectId, slug),
		queryFn: () => api.get<Skill>(`/api/projects/${projectId}/skills/${slug}`),
		enabled: !!projectId && slug !== null,
	});
}

export function useCreateSkill(projectId: string) {
	return useMutation({
		mutationFn: (input: CreateSkillInput) =>
			api.post<Skill>(`/api/projects/${projectId}/skills`, input),
		onSuccess: (created) => {
			queryClient.setQueryData<Skill>(queryKeys.projects.skill(projectId, created.slug), created);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.skills(projectId) });
		},
	});
}

export function useUpdateSkill(projectId: string) {
	return useMutation({
		mutationFn: ({ slug, input }: { slug: string; input: UpdateSkillInput }) =>
			api.patch<Skill>(`/api/projects/${projectId}/skills/${slug}`, input),
		onSuccess: (updated, { slug }) => {
			queryClient.setQueryData<Skill>(queryKeys.projects.skill(projectId, slug), updated);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.skills(projectId) });
		},
	});
}

export function useSyncSkill(projectId: string) {
	return useMutation({
		mutationFn: (slug: string) =>
			api.post<Skill>(`/api/projects/${projectId}/skills/${slug}/sync`, {}),
		onSuccess: (updated, slug) => {
			queryClient.setQueryData<Skill>(queryKeys.projects.skill(projectId, slug), updated);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.skills(projectId) });
		},
	});
}

export function useDeleteSkill(projectId: string) {
	return useMutation({
		mutationFn: (slug: string) => api.delete(`/api/projects/${projectId}/skills/${slug}`),
		onSuccess: (_, slug) => {
			queryClient.removeQueries({ queryKey: queryKeys.projects.skill(projectId, slug) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.skills(projectId) });
		},
	});
}
