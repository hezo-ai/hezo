import type { RegistrySkillSearchResult, SkillRecord } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export type Skill = SkillRecord;
export type SkillListItem = Omit<SkillRecord, 'content'>;
export interface CreateSkillInput {
	name: string;
	content: string;
	description?: string;
	slug?: string;
	tags?: string[];
}

// Skills are instance-global — one catalog shared with every team's agents.
// Only the Admin (superuser) manages them, via the /api/skills routes.
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
	return useMutation({
		mutationFn: ({ slug, ...data }: UpdateInstanceSkillPayload) =>
			api.patch<SkillListItem>(`/api/skills/${slug}`, data),
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

// --- skills.sh registry (admin "search and add"). Token-gated; agents bypass
// this entirely and discover skills with the `npx skills` CLI in the container.

const REGISTRY_TOKEN_KEY = [...INSTANCE_SKILLS_KEY, 'registry', 'token'] as const;

export function useRegistryTokenStatus() {
	return useQuery({
		queryKey: REGISTRY_TOKEN_KEY,
		queryFn: () => api.get<{ configured: boolean }>('/api/skills/registry/token'),
	});
}

export function useSetRegistryToken() {
	return useMutation({
		mutationFn: (token: string) =>
			api.put<{ configured: boolean }>('/api/skills/registry/token', { token }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: REGISTRY_TOKEN_KEY });
		},
	});
}

export function useSearchRegistrySkills(query: string) {
	const trimmed = query.trim();
	return useQuery({
		queryKey: [...INSTANCE_SKILLS_KEY, 'registry', 'search', trimmed],
		queryFn: () =>
			api.get<RegistrySkillSearchResult[]>(
				`/api/skills/registry/search?q=${encodeURIComponent(trimmed)}`,
			),
		enabled: trimmed.length >= 2,
		retry: false,
	});
}

export function useInstallRegistrySkill() {
	return useMutation({
		mutationFn: (id: string) =>
			api.post<{ slug: string; name: string }>('/api/skills/registry/install', { id }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_SKILLS_KEY });
		},
	});
}
