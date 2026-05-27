import type { CommentContentType } from '@hezo/shared';

/**
 * Per-content-type shapes for a comment's JSONB `content` column.
 *
 * The shapes here are what the **renderers** consume, not necessarily everything
 * the server emits. Fields are widened (`unknown` / optional) where the renderer
 * narrows defensively at use time; required where every renderer always reads
 * them. The discriminator is `CommentData["content_type"]`.
 */

export interface TextContent {
	/** Body text. Server inserts this as the markdown body. */
	text?: string;
}

export interface OptionsContent {
	prompt?: string;
	options?: Array<{ id: string; label: string; description?: string }>;
}

export interface PreviewContent {
	url?: string;
	preview_url?: string;
	title?: string;
}

export interface TraceContent {
	summary?: string;
}

export type SystemCommentKind =
	| 'status_change'
	| 'title_change'
	| 'assignee_change'
	| 'task_link'
	| 'run_failed'
	| 'run_terminated'
	| (string & { readonly __brand?: never });

export interface SystemContentBase {
	kind?: SystemCommentKind;
	text?: string;
}

export interface SystemStatusChangeContent extends SystemContentBase {
	kind: 'status_change';
	from?: string;
	to?: string;
	cascade?: string | null;
	triggered_by_identifier?: string;
	triggered_by_project_slug?: string;
}

export interface SystemTaskLinkContent extends SystemContentBase {
	kind: 'task_link';
	source_identifier?: string;
	source_project_slug?: string;
	actor_name?: string;
	actor_kind?: 'agent' | 'user' | 'board';
	actor_slug?: string | null;
}

export interface SystemRunFailedContent extends SystemContentBase {
	kind: 'run_failed';
	agent_slug?: string;
	status?: string;
	error?: string;
}

export type SystemContent =
	| SystemStatusChangeContent
	| SystemTaskLinkContent
	| SystemRunFailedContent
	| SystemContentBase;

export interface RunContent {
	run_id?: string;
	agent_id?: string;
	agent_title?: string;
}

export interface ActionContent {
	kind?: string;
	approval_id?: string;
}

export interface CredentialRequestContent {
	name?: string;
	kind?: string;
	instructions?: string;
	input_type?: string;
	confirmation_text?: string | null;
	placeholder?: string;
	allowed_hosts?: string[];
	scope?: string;
}

/**
 * Discriminated map: content shape per `content_type`. Adding a new
 * `CommentContentType` here is a compile error in the renderer registry
 * (see `comment-renderers/index.tsx`) until wired.
 */
export type CommentContentByType = {
	[CommentContentType.Text]: TextContent;
	[CommentContentType.Options]: OptionsContent;
	[CommentContentType.Preview]: PreviewContent;
	[CommentContentType.Trace]: TraceContent;
	[CommentContentType.System]: SystemContent;
	[CommentContentType.Run]: RunContent;
	[CommentContentType.Action]: ActionContent;
	[CommentContentType.CredentialRequest]: CredentialRequestContent;
};

/**
 * Per-content-type shapes for the JSONB `chosen_option` column.
 * Set on `options` when the board picks an option, on `credential_request`
 * when fulfilled, on `action` when the action completes. Null on all others.
 */
export interface OptionsChosen {
	chosen_id: string;
}

export interface CredentialRequestChosen {
	secret_id: string;
	fulfilled_at: string;
}

export interface ActionChosen {
	status: 'complete' | string;
	result?: {
		repo_id?: string;
		repo_identifier?: string;
		short_name?: string;
	};
}

export type CommentChosenByType = {
	[CommentContentType.Text]: null;
	[CommentContentType.Options]: OptionsChosen | null;
	[CommentContentType.Preview]: null;
	[CommentContentType.Trace]: null;
	[CommentContentType.System]: null;
	[CommentContentType.Run]: null;
	[CommentContentType.Action]: ActionChosen | null;
	[CommentContentType.CredentialRequest]: CredentialRequestChosen | null;
};

/** Per-tool input/output shape — JSONB; renderers don't narrow further. */
export type ToolCallInput = unknown;
export type ToolCallOutput = unknown;
