import {
	AlertTriangle,
	ArrowRightLeft,
	Dot,
	Link2,
	Pencil,
	Terminal,
	UserRoundCog,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import type { CommentData } from './comment-data';

export type LucideIcon = ComponentType<SVGProps<SVGSVGElement>>;

export const REACTION_GLYPH: Record<string, string> = { ack: '✓' };
export const REACTION_LABEL: Record<string, string> = { ack: 'Acknowledged' };
export const AVAILABLE_REACTION_KINDS = ['ack'] as const;

export function runStatusLabel(status: string): string {
	if (status === 'timed_out') return 'timed out';
	return status;
}

export function runStatusDotClass(status: string): string {
	if (status === 'running' || status === 'queued') return 'bg-accent-amber animate-pulse';
	if (status === 'succeeded') return 'bg-accent-green';
	if (status === 'failed' || status === 'timed_out') return 'bg-accent-red';
	return 'bg-text-subtle';
}

function systemEventIcon(kind: string | undefined): LucideIcon {
	switch (kind) {
		case 'status_change':
			return ArrowRightLeft;
		case 'title_change':
			return Pencil;
		case 'assignee_change':
			return UserRoundCog;
		case 'task_link':
			return Link2;
		case 'run_failed':
			return AlertTriangle;
		default:
			return Dot;
	}
}

export function inlineEventIcon(comment: CommentData): LucideIcon {
	if (comment.content_type === 'run') return Terminal;
	if (comment.content_type === 'system') {
		return systemEventIcon(comment.content?.kind);
	}
	return Dot;
}

export function isInlineEventType(contentType: string): boolean {
	return contentType === 'system' || contentType === 'run';
}
