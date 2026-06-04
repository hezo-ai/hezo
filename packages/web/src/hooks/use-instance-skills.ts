import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import type { CreateSkillInput, SkillListItem } from './use-skills';

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
	return useMutation({
		mutationFn: (data: CreateSkillInput) => api.post<SkillListItem>('/api/skills', data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_SKILLS_KEY });
		},
	});
}

export function useDeleteInstanceSkill() {
	return useMutation({
		mutationFn: (slug: string) => api.delete(`/api/skills/${slug}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_SKILLS_KEY });
		},
	});
}
