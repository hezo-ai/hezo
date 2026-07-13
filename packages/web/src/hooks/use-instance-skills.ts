import type {
	RegistrySkillSearchResult,
	SkillListItemRecord,
	SkillRecord,
	SkillRevisionRecord,
} from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export type Skill = SkillRecord;
export type SkillListItem = SkillListItemRecord;
export interface CreateSkillInput {
	name: string;
	content: string;
	description?: string;
	slug?: string;
	tags?: string[];
	/** null / omitted = global; a project id scopes it to that project. */
	project_id?: string | null;
}

// The global Skills page (/settings/skills) lists ALL skills — global (project_id
// null) and every project's — annotated with the owning project. Only the Admin
// (superuser) manages them and changes their scope, via the /api/skills routes.
// Skills are addressed by id (slug is no longer globally unique once scoped).
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

export function useInstanceSkill(id: string | null) {
	return useQuery({
		queryKey: [...INSTANCE_SKILLS_KEY, id],
		queryFn: () => api.get<Skill>(`/api/skills/${id}`),
		enabled: !!id,
	});
}

export interface UpdateInstanceSkillPayload {
	id: string;
	name?: string;
	description?: string;
	tags?: string[];
	content?: string;
}

export function useUpdateInstanceSkill() {
	return useMutation({
		mutationFn: ({ id, ...data }: UpdateInstanceSkillPayload) =>
			api.patch<SkillListItem>(`/api/skills/${id}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_SKILLS_KEY });
		},
	});
}

// Re-scope a skill (global <-> a project). Invalidate rather than optimistic —
// a cross-scope slug clash 409s. Mirrors useUpdateInstanceConnectorScope.
export function useUpdateInstanceSkillScope() {
	return useMutation({
		mutationFn: ({ id, project_id }: { id: string; project_id: string | null }) =>
			api.patch<SkillListItem>(`/api/skills/${id}`, { project_id }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_SKILLS_KEY });
		},
	});
}

export function useDeleteInstanceSkill() {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/skills/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_SKILLS_KEY });
		},
	});
}

// Revision history + restore — mirrors the agent system-prompt revision hooks.
export function useInstanceSkillRevisions(id: string | null) {
	return useQuery({
		queryKey: [...INSTANCE_SKILLS_KEY, id, 'revisions'],
		queryFn: () => api.get<SkillRevisionRecord[]>(`/api/skills/${id}/revisions`),
		enabled: !!id,
	});
}

export function useRestoreInstanceSkill(id: string | null) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post(`/api/skills/${id}/restore`, { revision_number: revisionNumber }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: INSTANCE_SKILLS_KEY });
			queryClient.invalidateQueries({ queryKey: [...INSTANCE_SKILLS_KEY, id] });
			queryClient.invalidateQueries({ queryKey: [...INSTANCE_SKILLS_KEY, id, 'revisions'] });
		},
	});
}

// --- default skills (the starter library Hezo ships). Not auto-seeded; the
// admin installs the missing ones from the global Skills page behind a confirm.

export interface MissingDefaultSkill {
	slug: string;
	name: string;
	description: string;
}

const MISSING_DEFAULTS_KEY = [...INSTANCE_SKILLS_KEY, 'defaults', 'missing'] as const;

export function useMissingDefaultSkills(enabled = true) {
	return useQuery({
		queryKey: MISSING_DEFAULTS_KEY,
		queryFn: () => api.get<{ missing: MissingDefaultSkill[] }>('/api/skills/defaults'),
		enabled,
	});
}

export function useInstallDefaultSkills() {
	return useMutation({
		mutationFn: (slugs?: string[]) =>
			api.post<{ installed: Array<{ id: string; slug: string; name: string }> }>(
				'/api/skills/defaults/install',
				slugs ? { slugs } : {},
			),
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
