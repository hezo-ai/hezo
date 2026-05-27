import type { CommentContentType } from '@hezo/shared';
import type { CommentAttachment, ReactionGroup } from '../../hooks/use-comments';
import type {
	CommentChosenByType,
	CommentContentByType,
	ToolCallInput,
	ToolCallOutput,
} from '../comment-content';

export interface ToolCall {
	id: string;
	tool_name: string;
	input: ToolCallInput;
	output: ToolCallOutput;
	status: string;
	duration_ms: number | null;
	created_at: string;
}

/**
 * Discriminated comment row keyed on `content_type`. Each variant carries the
 * `content` and `chosen_option` shape declared in `comment-content.ts`.
 */
export type CommentData = {
	[K in CommentContentType]: {
		id: string;
		content_type: K;
		content: CommentContentByType[K];
		chosen_option?: CommentChosenByType[K];
		author_name?: string;
		author_type?: string;
		created_at: string;
		tool_calls?: ToolCall[];
		reactions?: ReactionGroup[];
		attachments?: CommentAttachment[];
	};
}[CommentContentType];

/**
 * Narrowed-by-content_type variant of `CommentData`. Renderer components in
 * the registry receive `CommentDataOf<'text'>`, `CommentDataOf<'run'>`, etc.,
 * so `content`/`chosen_option` are typed without an inline cast.
 */
export type CommentDataOf<K extends CommentContentType> = Extract<CommentData, { content_type: K }>;
