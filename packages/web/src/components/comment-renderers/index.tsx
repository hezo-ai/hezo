import { CommentContentType } from '@hezo/shared';
import type { ComponentType } from 'react';
import { ActionComment } from './action-comment';
import type { CommentData, CommentDataOf } from './comment-data';
import { ConnectRequiredComment } from './connect-required-comment';
import { CredentialRequestComment } from './credential-request-comment';
import { OptionsComment } from './options-comment';
import { PreviewComment } from './preview-comment';
import { RunComment } from './run-comment';
import { SystemComment } from './system-comment';
import { TextComment } from './text-comment';
import { TraceComment } from './trace-comment';

export type { CommentData } from './comment-data';
export { CommentReactions } from './comment-reactions';
export { inlineEventIcon, isInlineEventType } from './helpers';

interface RenderProps {
	comment: CommentData;
	onChooseOption?: (commentId: string, chosenId: string) => void;
	teamId?: string;
	projectId?: string;
	projectSlug?: string;
	taskId?: string;
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
	onChooseOption?: RenderProps['onChooseOption'];
	teamId?: string;
	projectId?: string;
	projectSlug?: string;
	taskId?: string;
	inline?: boolean;
}>;

type RendererRegistry = { [K in CommentContentType]: RendererComponent<K> };

const renderers: RendererRegistry = {
	[CommentContentType.Text]: ({ comment, teamId, projectSlug }) => (
		<TextComment comment={comment} teamId={teamId} projectSlug={projectSlug} />
	),
	[CommentContentType.Options]: ({ comment, onChooseOption }) => (
		<OptionsComment comment={comment} onChoose={onChooseOption} />
	),
	[CommentContentType.Preview]: ({ comment }) => <PreviewComment comment={comment} />,
	[CommentContentType.Trace]: ({ comment }) => <TraceComment comment={comment} />,
	[CommentContentType.System]: ({ comment, teamId }) => (
		<SystemComment comment={comment} teamId={teamId} />
	),
	[CommentContentType.Run]: ({ comment, teamId, inline }) => (
		<RunComment comment={comment} teamId={teamId} inline={inline} />
	),
	[CommentContentType.Action]: ({ comment, teamId, projectId, taskId }) => (
		<ActionComment comment={comment} teamId={teamId} projectId={projectId} taskId={taskId} />
	),
	[CommentContentType.CredentialRequest]: ({ comment, teamId, taskId }) => (
		<CredentialRequestComment comment={comment} teamId={teamId} taskId={taskId} />
	),
	[CommentContentType.ConnectRequired]: ({ comment, teamId }) => (
		<ConnectRequiredComment comment={comment} teamId={teamId} />
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
		case CommentContentType.Options: {
			const C = renderers[CommentContentType.Options];
			return <C {...props} comment={comment} />;
		}
		case CommentContentType.Preview: {
			const C = renderers[CommentContentType.Preview];
			return <C {...props} comment={comment} />;
		}
		case CommentContentType.Trace: {
			const C = renderers[CommentContentType.Trace];
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
