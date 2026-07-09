import type { SkillListItemRecord, SkillRecord, SkillRevisionRecord } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

// The per-project Skills page (/projects/:projectId/skills) lists this project's
// own skills plus globals. Project-scoped rows are editable/removable here;
// global rows are read-only (managed on the global /settings/skills page).
// Scope changes are not possible here — those live on the global page.

export type ProjectSkillListItem = SkillListItemRecord;

export function useProjectSkills(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.skills(projectId),
		queryFn: () => api.get<ProjectSkillListItem[]>(`/api/projects/${projectId}/skills`),
	});
}

export function useProjectSkill(projectId: string, id: string | null) {
	return useQuery({
		queryKey: queryKeys.projects.skill(projectId, id),
		queryFn: () => api.get<SkillRecord>(`/api/projects/${projectId}/skills/${id}`),
		enabled: !!id,
	});
}

export interface UpdateProjectSkillPayload {
	id: string;
	name?: string;
	description?: string;
	tags?: string[];
	content?: string;
}

export function useUpdateProjectSkill(projectId: string) {
	return useMutation({
		mutationFn: ({ id, ...data }: UpdateProjectSkillPayload) =>
			api.patch<ProjectSkillListItem>(`/api/projects/${projectId}/skills/${id}`, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.skills(projectId) });
		},
	});
}

export function useDeleteProjectSkill(projectId: string) {
	return useMutation({
		mutationFn: (id: string) => api.delete(`/api/projects/${projectId}/skills/${id}`),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.skills(projectId) });
		},
	});
}

export function useProjectSkillRevisions(projectId: string, id: string | null) {
	return useQuery({
		queryKey: [...queryKeys.projects.skill(projectId, id), 'revisions'],
		queryFn: () =>
			api.get<SkillRevisionRecord[]>(`/api/projects/${projectId}/skills/${id}/revisions`),
		enabled: !!id,
	});
}

export function useRestoreProjectSkill(projectId: string, id: string | null) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post(`/api/projects/${projectId}/skills/${id}/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.skills(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.skill(projectId, id) });
			queryClient.invalidateQueries({
				queryKey: [...queryKeys.projects.skill(projectId, id), 'revisions'],
			});
		},
	});
}
