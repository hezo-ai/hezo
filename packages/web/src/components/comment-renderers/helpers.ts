import { HeartbeatRunStatus } from '@hezo/shared';
import {
	AlertTriangle,
	ArrowRightLeft,
	Dot,
	FileText,
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
	if (status === HeartbeatRunStatus.TimedOut) return 'timed out';
	return status;
}

/**
 * The one-line form of a run's `error`, for a place with a line to spare.
 *
 * The stored value is multi-line by design - a runner failure carries a stack,
 * the orphan pass appends a log tail - and the first line is the verdict in
 * every writer's shape, which is what a summary wants. The whole text stays one
 * click away in the expanded block and on the run page.
 */
export const RUN_ERROR_SUMMARY_MAX_CHARS = 180;

export function runErrorSummary(error: string | null | undefined): string | null {
	if (!error) return null;
	const first = error.split('\n', 1)[0].trim();
	if (!first) return null;
	return first.length > RUN_ERROR_SUMMARY_MAX_CHARS
		? `${first.slice(0, RUN_ERROR_SUMMARY_MAX_CHARS).trimEnd()}...`
		: first;
}

export function runStatusDotClass(status: string): string {
	if (status === HeartbeatRunStatus.Running || status === HeartbeatRunStatus.Queued)
		return 'bg-warning animate-pulse';
	if (status === HeartbeatRunStatus.Succeeded) return 'bg-success';
	if (status === HeartbeatRunStatus.Failed || status === HeartbeatRunStatus.TimedOut)
		return 'bg-danger';
	return 'bg-text-3';
}

function systemEventIcon(kind: string | undefined): LucideIcon {
	switch (kind) {
		case 'status_change':
			return ArrowRightLeft;
		case 'title_change':
			return Pencil;
		case 'description_change':
			return FileText;
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

// The canonical definition lives in `@hezo/shared` alongside the fold rule that
// reads it - both views must agree on which rows are events. Re-exported here so
// the renderer modules keep importing it from one place.
export { isInlineEventType } from '@hezo/shared';
