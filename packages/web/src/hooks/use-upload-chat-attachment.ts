import {
	ATTACHMENT_MAX_BYTES,
	isAllowedAttachmentExtension,
	resolveAttachmentContentType,
} from '@hezo/shared';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import type { CommentAttachment } from './use-comments';

/**
 * Uploads a file for the realtime chatbox (CEO chat). The file lands in the HQ
 * project's asset library under `uploads/chat/`; the returned asset id is
 * later sent with the message via `attachment_ids`. Mirrors
 * {@link useUploadAttachment} but targets the global CEO assets endpoint, so it
 * takes no project/task.
 */
export function useUploadChatAttachment() {
	return useMutation<CommentAttachment, ApiError, File>({
		mutationFn: async (file) => {
			if (!isAllowedAttachmentExtension(file.name)) {
				throw new ApiError('INVALID_TYPE', `Unsupported file extension: ${file.name}`, 400);
			}
			// See useUploadAttachment: the shared resolver is the single copy of this
			// rule, so the client and the server agree on every declared type.
			if (resolveAttachmentContentType(file.name, file.type) === null) {
				throw new ApiError('INVALID_TYPE', `Unsupported content type: ${file.type}`, 400);
			}
			if (file.size > ATTACHMENT_MAX_BYTES) {
				throw new ApiError('TOO_LARGE', 'File exceeds 10 MB', 400);
			}

			const fd = new FormData();
			fd.set('file', file, file.name);
			return api.postForm<CommentAttachment>('/api/chat/assets', fd);
		},
	});
}
