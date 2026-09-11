import { ApprovalType, CommentContentType } from '@hezo/shared';
import type { BadgeColor } from '../components/ui/badge';
import type { MessageKey } from './i18n';

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

/**
 * A Strategy row the run pipeline files when it has given up on an agent - the
 * retry budget is spent, or the model provider has refused its runs for hours.
 * It is a notice, not a proposal: there is nothing to approve or deny, only a
 * failed run to open. Every surface that treats it differently from a real
 * strategy proposal asks this one question, so it lives here beside them.
 *
 * The two shapes an approval reaches a surface in disagree on where the
 * discriminator sits: the inbox carries the whole `payload`, the project
 * dashboard carries only `payload_kind` off the row. Both are accepted.
 */
export function isAgentErrorApproval(approval: {
	type: string;
	payload?: Record<string, unknown>;
	payload_kind?: string | null;
}): boolean {
	const kind = approval.payload_kind ?? approval.payload?.type;
	return approval.type === ApprovalType.Strategy && kind === 'agent_error';
}

/**
 * How a run-failure notice presents, against the type badge it would otherwise
 * borrow. Its type says `strategy` and colours purple, which reads as a proposal
 * awaiting a decision rather than an agent that has stopped.
 */
export const AGENT_ERROR_ROW: {
	label: MessageKey;
	color: BadgeColor;
	text: MessageKey;
} = {
	label: 'approval.badge.agentError',
	color: 'danger',
	text: 'approval.text.agentError',
};
