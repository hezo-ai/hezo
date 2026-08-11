import { CommentContentType } from '@hezo/shared';

/**
 * How one admin-inbox row presents, keyed by the comment it is anchored to.
 * Three surfaces render these rows - the inbox itself, the project dashboard's
 * action items and the home "Needs you" list - and they must agree on what an
 * item is called and what its control does, so the descriptor lives here rather
 * than as a branch in each.
 */
export interface InboxRowKind {
	/** Badge text: the kind of ask. */
	tag: string;
	tagColor: 'info' | 'warning';
	/** Label on the row's action control. */
	actionLabel: string;
}

/** An `@admin` mention, and the fallback for any comment kind fanned out later. */
const MENTION: InboxRowKind = { tag: 'mention', tagColor: 'info', actionLabel: 'Reply' };

const BY_CONTENT_TYPE: Partial<Record<CommentContentType, InboxRowKind>> = {
	[CommentContentType.CredentialRequest]: {
		tag: 'credential',
		tagColor: 'warning',
		actionLabel: 'Provide',
	},
};

export function inboxRowKind(contentType: string | null | undefined): InboxRowKind {
	return BY_CONTENT_TYPE[contentType as CommentContentType] ?? MENTION;
}

/**
 * The row's own subject line, for a kind whose comment body is not the point.
 * Null means "this row reads as its author plus its snippet", which is how a
 * mention reads on every surface.
 */
export function inboxRowLead(item: {
	content_type?: string | null;
	credential_name?: string | null;
}): string | null {
	if (item.content_type !== CommentContentType.CredentialRequest) return null;
	return `provide ${item.credential_name ?? 'a credential'}`;
}
