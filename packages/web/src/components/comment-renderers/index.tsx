import { CommentContentType } from '@hezo/shared';
import type { ComponentType } from 'react';
import { ActionComment } from './action-comment';
import type { CommentData, CommentDataOf } from './comment-data';
import { ConnectRequiredComment } from './connect-required-comment';
import { CredentialRequestComment } from './credential-request-comment';
import { PreviewComment } from './preview-comment';
import { RunComment } from './run-comment';
import { SystemComment } from './system-comment';
import { TextComment } from './text-comment';

export type { CommentData } from './comment-data';
export { CommentReactions } from './comment-reactions';
export { CommentTimestampLink } from './comment-timestamp-link';
export { commentText, inlineEventIcon, isInlineEventType, jumpToComment } from './helpers';

interface RenderProps {
	comment: CommentData;
	projectId?: string;
	projectSlug?: string;
	taskId?: string;
	retryableRunId?: string | null;
	inline?: boolean;
}

/**
 * Per-content-type component contract. Each entry receives the narrowed
 * `CommentDataOf<K>` and the subset of render props its renderer reads. The
 * registry below declares one component per `CommentContentType`; adding a new
 * type to the shared enum becomes a compile error here until wired.
 */
type RendererComponent<K extends CommentContentType> = ComponentType<{
	comment: CommentDataOf<K>;
	projectId?: string;
	projectSlug?: string;
	taskId?: string;
	retryableRunId?: string | null;
	inline?: boolean;
}>;

type RendererRegistry = { [K in CommentContentType]: RendererComponent<K> };

const renderers: RendererRegistry = {
	[CommentContentType.Text]: ({ comment, projectId, projectSlug }) => (
		<TextComment comment={comment} projectId={projectId} projectSlug={projectSlug} />
	),
	[CommentContentType.Preview]: ({ comment }) => <PreviewComment comment={comment} />,
	[CommentContentType.System]: ({ comment, projectId }) => (
		<SystemComment comment={comment} projectId={projectId} />
	),
	[CommentContentType.Run]: ({ comment, projectId, taskId, retryableRunId, inline }) => (
		<RunComment
			comment={comment}
			projectId={projectId}
			taskId={taskId}
			retryableRunId={retryableRunId}
			inline={inline}
		/>
	),
	[CommentContentType.Action]: ({ comment, projectId, taskId }) => (
		<ActionComment comment={comment} projectId={projectId} taskId={taskId} />
	),
	[CommentContentType.CredentialRequest]: ({ comment, projectId, taskId }) => (
		<CredentialRequestComment comment={comment} projectId={projectId} taskId={taskId} />
	),
	[CommentContentType.ConnectRequired]: ({ comment, projectId }) => (
		<ConnectRequiredComment comment={comment} projectId={projectId} />
	),
};

export function CommentRenderer(props: RenderProps) {
	return dispatch(props);
}

function dispatch(props: RenderProps) {
	const { comment } = props;
	// Narrow once via the discriminator, then forward to the registered renderer.
	// The cast is contained here: TypeScript can't follow the `K -> Component<K>`
	// inference through the indexed access; callers see only the dispatcher.
	switch (comment.content_type) {
		case CommentContentType.Text: {
			const C = renderers[CommentContentType.Text];
			return <C {...props} comment={comment} />;
		}
		case CommentContentType.Preview: {
			const C = renderers[CommentContentType.Preview];
			return <C {...props} comment={comment} />;
		}
		case CommentContentType.System: {
			const C = renderers[CommentContentType.System];
			return <C {...props} comment={comment} />;
		}
		case CommentContentType.Run: {
			const C = renderers[CommentContentType.Run];
			return <C {...props} comment={comment} />;
		}
		case CommentContentType.Action: {
			const C = renderers[CommentContentType.Action];
			return <C {...props} comment={comment} />;
		}
		case CommentContentType.CredentialRequest: {
			const C = renderers[CommentContentType.CredentialRequest];
			return <C {...props} comment={comment} />;
		}
		case CommentContentType.ConnectRequired: {
			const C = renderers[CommentContentType.ConnectRequired];
			return <C {...props} comment={comment} />;
		}
		default: {
			// If a new CommentContentType is added but not wired here, this fails
			// to compile: `never` no longer satisfies the new variant.
			const _exhaustive: never = comment;
			void _exhaustive;
			return null;
		}
	}
}
