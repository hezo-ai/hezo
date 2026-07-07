import {
	ATTACHMENT_MAX_BYTES,
	type CommentAttachment,
	isAllowedAttachmentExtension,
	type ProjectAsset,
	resolveAttachmentContentType,
} from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';

export type { ProjectAsset };

export function useProjectAssets(projectId: string) {
	return useQuery({
		queryKey: queryKeys.projects.assets(projectId),
		queryFn: () => api.get<ProjectAsset[]>(`/api/projects/${projectId}/assets`),
		enabled: !!projectId,
	});
}

export interface UploadAssetInput {
	file: File;
	/** Library folder to upload into ('' or undefined = root, up to 2 levels). */
	folder?: string;
}

// Uploads and deletes are invalidate + refetch (not optimistic): the server
// assigns the final, collision-suffixed filename and the list view re-flows.
export function useUploadProjectAsset(projectId: string) {
	return useMutation<CommentAttachment, ApiError, UploadAssetInput>({
		mutationFn: async ({ file, folder }) => {
			if (!isAllowedAttachmentExtension(file.name)) {
				throw new ApiError('INVALID_TYPE', `Unsupported file type: ${file.name}`, 400);
			}
			// Mirrors the server's resolution: script/text extensions coerce to
			// text/plain (browsers declare text/javascript etc.), other extensions
			// reject a contradictory declared type.
			if (resolveAttachmentContentType(file.name, file.type) === null) {
				throw new ApiError('INVALID_TYPE', `Unsupported content type: ${file.type}`, 400);
			}
			if (file.size > ATTACHMENT_MAX_BYTES) {
				throw new ApiError('TOO_LARGE', 'File exceeds 10 MB', 400);
			}
			const fd = new FormData();
			fd.set('file', file, file.name);
			if (folder) fd.set('folder', folder);
			return api.postForm<CommentAttachment>(`/api/projects/${projectId}/assets`, fd);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.assets(projectId),
			});
		},
	});
}

export function useDeleteProjectAsset(projectId: string) {
	return useMutation<unknown, ApiError, string>({
		mutationFn: (assetId) => api.delete(`/api/projects/${projectId}/assets/${assetId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.assets(projectId),
			});
		},
	});
}

/** Archive or restore an asset (the soft delete). Response-driven: the server
 * stamps archived_at and the list re-flows on refetch. */
export function useArchiveProjectAsset(projectId: string) {
	return useMutation<ProjectAsset, ApiError, { assetId: string; archived: boolean }>({
		mutationFn: ({ assetId, archived }) =>
			api.patch<ProjectAsset>(`/api/projects/${projectId}/assets/${assetId}`, { archived }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.assets(projectId),
			});
		},
	});
}

/** Move an asset to a library folder ('' = root). Response-driven: the server
 * owns the final path (409 on collision) and the list re-flows on refetch. */
export function useMoveProjectAsset(projectId: string) {
	return useMutation<ProjectAsset, ApiError, { assetId: string; folder: string }>({
		mutationFn: ({ assetId, folder }) =>
			api.patch<ProjectAsset>(`/api/projects/${projectId}/assets/${assetId}`, { folder }),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.assets(projectId),
			});
		},
	});
}
