import {
	ATTACHMENT_MAX_BYTES,
	isAllowedAttachmentExtension,
	isAllowedAttachmentMime,
} from '@hezo/shared';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import type { CommentAttachment } from './use-comments';

export function useUploadAttachment(projectId: string, taskId: string) {
	return useMutation<CommentAttachment, ApiError, File>({
		mutationFn: async (file) => {
			if (!isAllowedAttachmentExtension(file.name)) {
				throw new ApiError('INVALID_TYPE', `Unsupported file extension: ${file.name}`, 400);
			}
			if (file.type && !isAllowedAttachmentMime(file.type)) {
				throw new ApiError('INVALID_TYPE', `Unsupported content type: ${file.type}`, 400);
			}
			if (file.size > ATTACHMENT_MAX_BYTES) {
				throw new ApiError('TOO_LARGE', 'File exceeds 10 MB', 400);
			}

			const fd = new FormData();
			fd.set('file', file, file.name);
			return api.postForm<CommentAttachment>(
				`/api/projects/${projectId}/tasks/${taskId}/assets`,
				fd,
			);
		},
	});
}
