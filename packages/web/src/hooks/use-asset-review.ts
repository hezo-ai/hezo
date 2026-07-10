import type { ReviewComment } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';

/**
 * Review comments on a project asset. Text assets (markdown, plain text)
 * anchor with quote/occurrence exactly like documents; every other type takes
 * un-anchored whole-asset comments. Version-scoped: any overwrite of the
 * asset's path wipes them server-side (and swaps the asset id).
 *
 * The API path is keyed by the asset UUID (asset paths contain `/`); the query
 * key is keyed by the `?file` route value per the slug-vs-UUID rule, so
 * WS-driven invalidations of the `assets` prefix reach it.
 */
export type AssetReviewComment = ReviewComment;

function base(projectId: string, assetId: string): string {
	return `/api/projects/${projectId}/assets/${assetId}/review-comments`;
}

export function useAssetReviewComments(
	projectId: string,
	file: string | null,
	assetId: string | undefined,
) {
	return useQuery({
		queryKey: queryKeys.projects.assetReviewComments(projectId, file),
		queryFn: () => api.get<AssetReviewComment[]>(base(projectId, assetId as string)),
		enabled: !!projectId && !!file && !!assetId,
	});
}

export interface CreateAssetReviewCommentVars {
	/** Omitted for whole-asset comments (non-text assets). */
	quote?: string;
	occurrence?: number;
	comment: string;
	/** The asset `sha256` the client rendered — server 409s if stale. */
	assetSha256?: string;
}

/** Response-driven (a create needs the server id); appends from the response. */
export function useCreateAssetReviewComment(projectId: string, file: string, assetId: string) {
	return useMutation({
		mutationFn: (vars: CreateAssetReviewCommentVars) =>
			api.post<AssetReviewComment>(base(projectId, assetId), {
				quote: vars.quote,
				occurrence: vars.occurrence,
				comment: vars.comment,
				asset_sha256: vars.assetSha256,
			}),
		onSuccess: (created) => {
			queryClient.setQueryData<AssetReviewComment[]>(
				queryKeys.projects.assetReviewComments(projectId, file),
				(prev) => (prev ? [...prev, created] : [created]),
			);
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.assetReviewComments(projectId, file),
			});
		},
	});
}

export function useUpdateAssetReviewComment(projectId: string, file: string, assetId: string) {
	return useOptimisticMutation<
		{ commentId: string; comment: string },
		AssetReviewComment,
		AssetReviewComment[]
	>({
		mutationFn: ({ commentId, comment }) =>
			api.patch<AssetReviewComment>(`${base(projectId, assetId)}/${commentId}`, { comment }),
		queryKey: queryKeys.projects.assetReviewComments(projectId, file),
		applyOptimistic: (current, vars) =>
			current?.map((c) => (c.id === vars.commentId ? { ...c, comment: vars.comment } : c)),
		mergeResponse: (current, updated) => current?.map((c) => (c.id === updated.id ? updated : c)),
		errorMessage: 'Failed to update comment',
	});
}

export function useDeleteAssetReviewComment(projectId: string, file: string, assetId: string) {
	return useOptimisticMutation<{ commentId: string }, unknown, AssetReviewComment[]>({
		mutationFn: ({ commentId }) => api.delete(`${base(projectId, assetId)}/${commentId}`),
		queryKey: queryKeys.projects.assetReviewComments(projectId, file),
		applyOptimistic: (current, vars) => current?.filter((c) => c.id !== vars.commentId),
		errorMessage: 'Failed to delete comment',
	});
}

export function useClearAssetReviewComments(projectId: string, file: string, assetId: string) {
	return useOptimisticMutation<void, unknown, AssetReviewComment[]>({
		mutationFn: () => api.delete(base(projectId, assetId)),
		queryKey: queryKeys.projects.assetReviewComments(projectId, file),
		applyOptimistic: () => [],
		errorMessage: 'Failed to clear review',
	});
}
