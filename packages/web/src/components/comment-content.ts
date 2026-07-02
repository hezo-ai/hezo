import type { CommentContentType } from '@hezo/shared';

/**
 * Per-content-type shapes for a comment's JSONB `content` column.
 *
 * The shapes here are what the **renderers** consume, not necessarily everything
 * the server emits. Fields are widened (`unknown` / optional) where the renderer
 * narrows defensively at use time; required where every renderer always reads
 * them. The discriminator is `CommentData["content_type"]`.
 */

/**
 * Body text. The composer sends a plain string; the seed and some API paths
 * wrap it as `{ text }`. The server stores whichever form it received, so the
 * renderer must handle both.
 */
export type TextContent = string | { text?: string };

export interface PreviewContent {
	url?: string;
	preview_url?: string;
	title?: string;
}

export interface SystemStatusChangeContent {
	kind: 'status_change';
	from?: string;
	to?: string;
	cascade?: string | null;
	triggered_by_identifier?: string;
	triggered_by_project_slug?: string;
	text?: string;
}

export interface SystemTaskLinkContent {
	kind: 'task_link';
	source_identifier?: string;
	source_project_slug?: string;
	actor_name?: string;
	actor_kind?: 'agent' | 'user' | 'admin';
	actor_slug?: string | null;
	text?: string;
}

export interface SystemRunFailedContent {
	kind: 'run_failed';
	agent_slug?: string;
	status?: string;
	error?: string;
	run_id?: string;
	text?: string;
}

export interface SystemRepoDesignatedContent {
	kind: 'repo_designated';
	repo_identifier?: string;
	host_type?: string;
	text?: string;
}

/**
 * Catch-all for system events that don't have a dedicated renderer branch
 * (`title_change`, `assignee_change`, `run_terminated`, future kinds). Renderers
 * fall back to rendering the `text` field or stringifying the payload. The
 * `kind` literal is intentionally distinct from the dedicated variants so the
 * discriminated union narrows correctly on `content.kind === '...'`.
 */
export interface SystemGenericContent {
	kind?: 'title_change' | 'assignee_change' | 'run_terminated' | (string & Record<never, never>);
	text?: string;
}

export type SystemContent =
	| SystemStatusChangeContent
	| SystemTaskLinkContent
	| SystemRunFailedContent
	| SystemRepoDesignatedContent
	| SystemGenericContent;

export interface RunContent {
	run_id?: string;
	agent_id?: string;
	agent_title?: string;
	agent_slug?: string;
	actor_id?: string | null;
	actor_name?: string;
}

export interface ActionContent {
	kind?: string;
	approval_id?: string;
	// hire_proposal snapshot (kind === 'hire_proposal')
	title?: string;
	slug?: string;
	role_description?: string;
	monthly_budget_cents?: number;
	heartbeat_interval_min?: number | null;
	touches_code?: boolean;
}

export interface CredentialRequestContent {
	name?: string;
	kind?: string;
	instructions?: string;
	input_type?: string;
	confirmation_text?: string | null;
	placeholder?: string;
	allowed_hosts?: string[];
	allow_body_substitution?: boolean;
	scope?: string;
}

export interface ConnectRequiredContent {
	connector_id: string;
	display_name: string;
	provider_id?: string;
	skill_doc_slug?: string;
}

export interface AssetDeletionRequestContent {
	/** Request-time snapshot of the assets to delete (id + full path). */
	assets?: Array<{ id: string; path: string }>;
	reason?: string;
	/** Human-readable one-liner (feeds the inbox snippet). */
	text?: string;
}

/**
 * Discriminated map: content shape per `content_type`. Adding a new
 * `CommentContentType` here is a compile error in the renderer registry
 * (see `comment-renderers/index.tsx`) until wired.
 */
export type CommentContentByType = {
	[CommentContentType.Text]: TextContent;
	[CommentContentType.Preview]: PreviewContent;
	[CommentContentType.System]: SystemContent;
	[CommentContentType.Run]: RunContent;
	[CommentContentType.Action]: ActionContent;
	[CommentContentType.CredentialRequest]: CredentialRequestContent;
	[CommentContentType.ConnectRequired]: ConnectRequiredContent;
	[CommentContentType.AssetDeletionRequest]: AssetDeletionRequestContent;
};

/**
 * Per-content-type shapes for the JSONB `chosen_option` column.
 * Set on `options` when the admin picks an option, on `credential_request`
 * when fulfilled, on `action` when the action completes. Null on all others.
 */
export interface CredentialRequestChosen {
	secret_id: string;
	fulfilled_at: string;
}

export interface ActionChosen {
	status: 'complete' | 'approved' | 'denied' | string;
	result?: {
		repo_id?: string;
		repo_identifier?: string;
	};
	// set when a hire_proposal action resolves
	member_agent_slug?: string;
	resolution_note?: string;
	resolved_at?: string;
}

export interface AssetDeletionRequestChosen {
	status: 'approved' | 'denied' | (string & Record<never, never>);
	resolved_at?: string;
	/** Ids actually deleted on approval (assets gone before resolution are omitted). */
	deleted_asset_ids?: string[];
}

export type CommentChosenByType = {
	[CommentContentType.Text]: null;
	[CommentContentType.Preview]: null;
	[CommentContentType.System]: null;
	[CommentContentType.Run]: null;
	[CommentContentType.Action]: ActionChosen | null;
	[CommentContentType.CredentialRequest]: CredentialRequestChosen | null;
	[CommentContentType.ConnectRequired]: null;
	[CommentContentType.AssetDeletionRequest]: AssetDeletionRequestChosen | null;
};
