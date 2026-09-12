import {
	ATTACHMENT_MAX_BYTES,
	isAllowedAttachmentExtension,
	resolveAttachmentContentType,
} from '@hezo/shared';
import { useMutation } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';
import type { CommentAttachment } from './use-comments';

/**
 * Uploads a file for the chat dock. With `projectSlug` set the file lands in
 * that project's asset library (agent DMs); with `null` it targets the global
 * CEO endpoint and lands under HQ. Either way the destination is
 * `uploads/chat/` and the returned asset id is later sent with the message via
 * `attachment_ids`. Mirrors {@link useUploadAttachment} but takes no task.
 */
export function useUploadChatAttachment(projectSlug: string | null) {
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
			const path = projectSlug ? `/api/projects/${projectSlug}/chat/assets` : '/api/chat/assets';
			return api.postForm<CommentAttachment>(path, fd);
		},
	});
}
