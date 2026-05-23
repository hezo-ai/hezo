import {
	ATTACHMENT_MAX_BYTES,
	isAllowedAttachmentExtension,
	isAllowedAttachmentMime,
} from '@hezo/shared';
import { useMutation } from '@tanstack/react-query';
import { type ApiError, api } from '../lib/api';
import type { CommentAttachment } from './use-comments';

export function useUploadAttachment(teamId: string, taskId: string) {
	return useMutation<CommentAttachment, ApiError, File>({
		mutationFn: async (file) => {
			if (!isAllowedAttachmentExtension(file.name)) {
				throw {
					code: 'INVALID_TYPE',
					message: `Unsupported file extension: ${file.name}`,
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
				throw {
					code: 'TOO_LARGE',
					message: 'File exceeds 10 MB',
					status: 400,
				} as ApiError;
			}

			const fd = new FormData();
			fd.set('file', file, file.name);
			return api.postForm<CommentAttachment>(`/api/teams/${teamId}/tasks/${taskId}/assets`, fd);
		},
	});
}
