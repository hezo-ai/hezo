import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';

/**
 * Review comments on a project document — view-mode highlight annotations.
 * Version-scoped: any content change to the document wipes them server-side,
 * so a fetched comment's quote/occurrence anchor always matches the current
 * document content.
 */
export interface DocReviewComment {
	id: string;
	document_id: string;
	quote: string;
	occurrence: number;
	comment: string;
	author_member_id: string | null;
	doc_updated_at: string;
	created_at: string;
	updated_at: string;
}

function base(projectId: string, filename: string): string {
	return `/api/projects/${projectId}/docs/${encodeURIComponent(filename)}/review-comments`;
}

export function useDocReviewComments(projectId: string, filename: string | null) {
	return useQuery({
		queryKey: queryKeys.projects.docReviewComments(projectId, filename),
		queryFn: () => api.get<DocReviewComment[]>(base(projectId, filename as string)),
		enabled: !!projectId && !!filename,
	});
}

export interface CreateReviewCommentVars {
	quote: string;
	occurrence: number;
	comment: string;
	/** The document `updated_at` the client rendered — server 409s if stale. */
	docUpdatedAt?: string;
}

/** Response-driven (a create needs the server id); appends from the response. */
export function useCreateDocReviewComment(projectId: string, filename: string) {
	return useMutation({
		mutationFn: (vars: CreateReviewCommentVars) =>
			api.post<DocReviewComment>(base(projectId, filename), {
				quote: vars.quote,
				occurrence: vars.occurrence,
				comment: vars.comment,
				doc_updated_at: vars.docUpdatedAt,
			}),
		onSuccess: (created) => {
			queryClient.setQueryData<DocReviewComment[]>(
				queryKeys.projects.docReviewComments(projectId, filename),
				(prev) => (prev ? [...prev, created] : [created]),
			);
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.docReviewComments(projectId, filename),
			});
		},
	});
}

export function useUpdateDocReviewComment(projectId: string, filename: string) {
	return useOptimisticMutation<
		{ commentId: string; comment: string },
		DocReviewComment,
		DocReviewComment[]
	>({
		mutationFn: ({ commentId, comment }) =>
			api.patch<DocReviewComment>(`${base(projectId, filename)}/${commentId}`, { comment }),
		queryKey: queryKeys.projects.docReviewComments(projectId, filename),
		applyOptimistic: (current, vars) =>
			current?.map((c) => (c.id === vars.commentId ? { ...c, comment: vars.comment } : c)),
		mergeResponse: (current, updated) => current?.map((c) => (c.id === updated.id ? updated : c)),
		errorMessage: 'Failed to update comment',
	});
}

export function useDeleteDocReviewComment(projectId: string, filename: string) {
	return useOptimisticMutation<{ commentId: string }, unknown, DocReviewComment[]>({
		mutationFn: ({ commentId }) => api.delete(`${base(projectId, filename)}/${commentId}`),
		queryKey: queryKeys.projects.docReviewComments(projectId, filename),
		applyOptimistic: (current, vars) => current?.filter((c) => c.id !== vars.commentId),
		errorMessage: 'Failed to delete comment',
	});
}

export function useClearDocReviewComments(projectId: string, filename: string) {
	return useOptimisticMutation<void, unknown, DocReviewComment[]>({
		mutationFn: () => api.delete(base(projectId, filename)),
		queryKey: queryKeys.projects.docReviewComments(projectId, filename),
		applyOptimistic: () => [],
		errorMessage: 'Failed to clear review',
	});
}
