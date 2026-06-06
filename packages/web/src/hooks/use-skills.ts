import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useInvalidatingMutation } from './use-invalidating-mutation';
import { useResponseMutation } from './use-response-mutation';

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

const listKey = (teamId: string) => ['teams', teamId, 'skills'] as const;
const detailKey = (teamId: string, slug: string) => ['teams', teamId, 'skills', slug] as const;

export function useSkills(teamId: string) {
	return useQuery({
		queryKey: listKey(teamId),
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

// Create/update/sync are response-driven: the server computes the slug and
// content_hash (and, for sync, re-downloads), so the detail cache is seeded
// from the response and the list is invalidated to re-flow.

export function useCreateSkill(teamId: string) {
	return useResponseMutation<CreateSkillInput, Skill, Skill>({
		mutationFn: (input) => api.post<Skill>(`/api/teams/${teamId}/skills`, input),
		queryKey: (_input, created) => detailKey(teamId, created.slug),
		merge: (_current, created) => created,
		invalidateOnSettled: [listKey(teamId)],
	});
}

export function useUpdateSkill(teamId: string) {
	return useResponseMutation<{ slug: string; input: UpdateSkillInput }, Skill, Skill>({
		mutationFn: ({ slug, input }) => api.patch<Skill>(`/api/teams/${teamId}/skills/${slug}`, input),
		queryKey: ({ slug }) => detailKey(teamId, slug),
		merge: (_current, updated) => updated,
		invalidateOnSettled: [listKey(teamId)],
	});
}

export function useSyncSkill(teamId: string) {
	return useResponseMutation<string, Skill, Skill>({
		mutationFn: (slug) => api.post<Skill>(`/api/teams/${teamId}/skills/${slug}/sync`, {}),
		queryKey: (slug) => detailKey(teamId, slug),
		merge: (_current, updated) => updated,
		invalidateOnSettled: [listKey(teamId)],
	});
}

export function useDeleteSkill(teamId: string) {
	return useInvalidatingMutation<string, unknown>({
		mutationFn: (slug) => api.delete(`/api/teams/${teamId}/skills/${slug}`),
		invalidate: [listKey(teamId)],
		onSuccess: (_data, slug) => {
			queryClient.removeQueries({ queryKey: detailKey(teamId, slug) });
		},
	});
}
