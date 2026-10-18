import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/query-keys';
import { CEO_ROOM, postChatTurn } from './use-chat';
import type { CommentAttachment } from './use-comments';
import { useUploadChatAttachment } from './use-upload-chat-attachment';

export interface PlanWithCeoInput {
	/** The composed first message (`composePlanWithCeoMessage`). */
	text: string;
	/** The project plan's markdown, when the admin attached or pasted one. */
	plan: string | null;
	/** The plan's original filename; pasted content has none. */
	planFilename: string | null;
}

/**
 * The chat attachment allow-list takes `.md` but not `.markdown`, and pasted
 * content has no name, so the plan always travels as a `.md` file.
 */
function planFileName(original: string | null): string {
	const stem = original?.replace(/\.(md|markdown|txt)$/i, '').trim();
	return `${stem || 'project-plan'}.md`;
}

/**
 * Send the New Project form to the CEO as the admin's first chat message, the
 * plan attached. Response-driven: the dialog closes on success and the chat
 * shows the stored message, so nothing is drawn before the server accepts it.
 */
export function usePlanWithCeo() {
	const queryClient = useQueryClient();
	const upload = useUploadChatAttachment(null);
	return useMutation({
		mutationFn: async (input: PlanWithCeoInput) => {
			const attachments: CommentAttachment[] = [];
			if (input.plan) {
				const file = new File([input.plan], planFileName(input.planFilename), {
					type: 'text/markdown',
				});
				attachments.push(await upload.mutateAsync(file));
			}
			return postChatTurn(CEO_ROOM, [{ text: input.text, attachments }]);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.chatConversation() });
		},
	});
}
