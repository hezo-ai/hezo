import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';

export interface CustomPrompt {
	id: string;
	team_id: string;
	content: string;
	updated_at: string;
}

export function useCustomPrompt(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.customPrompt(projectId),
		queryFn: () => api.get<CustomPrompt | null>(`/api/projects/${projectId}/custom-prompt`),
	});
}

export interface CustomPromptRevision {
	id: string;
	document_id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	author_name: string | null;
	/** 'agent' | 'admin' | 'api_key' — drives the human/API-key badge. */
	author_type?: string;
	author_api_key_id?: string | null;
	created_at: string;
}

export function useCustomPromptRevisions(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.customPromptRevisions(projectId),
		queryFn: () =>
			api.get<CustomPromptRevision[]>(`/api/projects/${projectId}/custom-prompt/revisions`),
	});
}

export function useUpdateCustomPrompt(projectId: string) {
	return useOptimisticMutation<
		{ content: string; change_summary?: string },
		CustomPrompt,
		CustomPrompt | null
	>({
		mutationFn: (data) => api.patch<CustomPrompt>(`/api/projects/${projectId}/custom-prompt`, data),
		queryKey: queryKeys.projects.customPrompt(projectId),
		applyOptimistic: (current, { content }) => (current ? { ...current, content } : current),
		mergeResponse: (current, updated) => (current ? { ...current, ...updated } : updated),
		invalidateOnSettled: [queryKeys.projects.customPromptRevisions(projectId)],
		errorMessage: 'Failed to update Custom Prompt',
	});
}

export function useRestoreCustomPromptRevision(projectId: string) {
	return useMutation({
		mutationFn: (revisionNumber: number) =>
			api.post<CustomPrompt>(`/api/projects/${projectId}/custom-prompt/restore`, {
				revision_number: revisionNumber,
			}),
		onSuccess: (restored) => {
			queryClient.setQueryData<CustomPrompt | null>(
				queryKeys.projects.customPrompt(projectId),
				restored,
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.customPrompt(projectId) });
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.customPromptRevisions(projectId),
			});
		},
	});
}
