import {
	ATTACHMENT_MAX_BYTES,
	type CommentAttachment,
	isAllowedAttachmentExtension,
	type ProjectAsset,
	resolveAttachmentContentType,
} from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';
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
				throw {
					code: 'INVALID_TYPE',
					message: `Unsupported file type: ${file.name}`,
					status: 400,
				} as ApiError;
			}
			// Mirrors the server's resolution: script/text extensions coerce to
			// text/plain (browsers declare text/javascript etc.), other extensions
			// reject a contradictory declared type.
			if (resolveAttachmentContentType(file.name, file.type) === null) {
				throw {
					code: 'INVALID_TYPE',
					message: `Unsupported content type: ${file.type}`,
					status: 400,
				} as ApiError;
			}
			if (file.size > ATTACHMENT_MAX_BYTES) {
				throw { code: 'TOO_LARGE', message: 'File exceeds 10 MB', status: 400 } as ApiError;
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
