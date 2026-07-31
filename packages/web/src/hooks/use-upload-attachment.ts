import {
	ATTACHMENT_MAX_BYTES,
	isAllowedAttachmentExtension,
	resolveAttachmentContentType,
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
			// Same rule the server applies in `storeUploadedAsset`, called rather than
			// re-derived: a weaker local copy rejected declared types the server would
			// have accepted (a .zip arrives as `application/x-zip-compressed` on
			// Windows Chrome and Edge, which is not itself an allowlisted type).
			if (resolveAttachmentContentType(file.name, file.type) === null) {
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
