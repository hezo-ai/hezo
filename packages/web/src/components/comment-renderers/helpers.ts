import {
	AlertTriangle,
	ArrowRightLeft,
	Dot,
	Link2,
	Pencil,
	Terminal,
	UserRoundCog,
} from 'lucide-react';
import type { ComponentType, MouseEvent, SVGProps } from 'react';
import type { TextContent } from '../comment-content';
import type { CommentData } from './comment-data';

export type LucideIcon = ComponentType<SVGProps<SVGSVGElement>>;

/** Drive the page's hashchange handler from any anchor — Virtuoso may not
 * have the target row mounted yet, so the scroll has to flow through the
 * `useEffect` in `comments-section.tsx`. */
export function jumpToComment(commentId: string) {
	return (e: MouseEvent) => {
		e.preventDefault();
		const target = `#comment-${commentId}`;
		window.history.pushState(null, '', target);
		window.dispatchEvent(new HashChangeEvent('hashchange'));
	};
}

/**
 * Normalize a text comment's `content` to its body string. The composer sends a
 * plain string; the seed and some API paths wrap it as `{ text }`. Falls back to
 * the JSON form for an unexpected object shape (matches the renderer's behaviour).
 */
export function commentText(content: TextContent): string {
	if (typeof content === 'string') return content;
	if (content && typeof content === 'object') {
		return typeof content.text === 'string' ? content.text : JSON.stringify(content);
	}
	return '';
}

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
