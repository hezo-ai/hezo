import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useInvalidatingMutation } from './use-invalidating-mutation';
import type { CreateSkillInput, Skill, SkillListItem } from './use-skills';

// Instance-level skills (team_id NULL) are shared with every team. Only the
// Admin (superuser) manages them, via the un-prefixed /api/skills routes.
export const INSTANCE_SKILLS_KEY = ['instance', 'skills'] as const;

export function useInstanceSkills() {
	return useQuery({
		queryKey: INSTANCE_SKILLS_KEY,
		queryFn: () => api.get<SkillListItem[]>('/api/skills'),
	});
}

export function useCreateInstanceSkill() {
	return useInvalidatingMutation<CreateSkillInput, SkillListItem>({
		mutationFn: (data) => api.post<SkillListItem>('/api/skills', data),
		invalidate: [INSTANCE_SKILLS_KEY],
	});
}

export function useInstanceSkill(slug: string | null) {
	return useQuery({
		queryKey: [...INSTANCE_SKILLS_KEY, slug],
		queryFn: () => api.get<Skill>(`/api/skills/${slug}`),
		enabled: !!slug,
	});
}

export interface UpdateInstanceSkillPayload {
	slug: string;
	name?: string;
	description?: string;
	tags?: string[];
	content?: string;
}

export function useUpdateInstanceSkill() {
	return useInvalidatingMutation<UpdateInstanceSkillPayload, SkillListItem>({
		mutationFn: ({ slug, ...data }) => api.patch<SkillListItem>(`/api/skills/${slug}`, data),
		invalidate: [INSTANCE_SKILLS_KEY],
	});
}

export function useDeleteInstanceSkill() {
	return useInvalidatingMutation<string, unknown>({
		mutationFn: (slug) => api.delete(`/api/skills/${slug}`),
		invalidate: [INSTANCE_SKILLS_KEY],
	});
}
