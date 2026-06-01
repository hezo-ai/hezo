import {
	ATTACHMENT_MAX_BYTES,
	type CommentAttachment,
	isAllowedAttachmentExtension,
	isAllowedAttachmentMime,
	type ProjectAsset,
} from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';
import { queryClient } from '../lib/query-client';

export type { ProjectAsset };

export function useProjectAssets(teamId: string, projectId: string) {
	return useQuery({
		queryKey: ['teams', teamId, 'projects', projectId, 'assets'],
		queryFn: () => api.get<ProjectAsset[]>(`/api/teams/${teamId}/projects/${projectId}/assets`),
		enabled: !!projectId,
	});
}

// Uploads and deletes are invalidate + refetch (not optimistic): the server
// assigns the final, collision-suffixed filename and the list view re-flows.
export function useUploadProjectAsset(teamId: string, projectId: string) {
	return useMutation<CommentAttachment, ApiError, File>({
		mutationFn: async (file) => {
			if (!isAllowedAttachmentExtension(file.name)) {
				throw {
					code: 'INVALID_TYPE',
					message: `Unsupported file type: ${file.name}`,
					status: 400,
				} as ApiError;
			}
			if (file.type && !isAllowedAttachmentMime(file.type)) {
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
			return api.postForm<CommentAttachment>(
				`/api/teams/${teamId}/projects/${projectId}/assets`,
				fd,
			);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'assets'],
			});
		},
	});
}

export function useDeleteProjectAsset(teamId: string, projectId: string) {
	return useMutation<unknown, ApiError, string>({
		mutationFn: (assetId) =>
			api.delete(`/api/teams/${teamId}/projects/${projectId}/assets/${assetId}`),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ['teams', teamId, 'projects', projectId, 'assets'],
			});
		},
	});
}
