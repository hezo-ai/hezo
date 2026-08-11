import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Tooltip } from './ui/tooltip';

/** Shared styling for every entity mention/reference link. */
export const MENTION_CLASSES = 'font-semibold text-[1.05em] text-info-soft-fg hover:underline';

/**
 * A passive teammate reference (`@@slug`) renders as the bare slug, so without a
 * distinct treatment it is indistinguishable from an active `@slug` chip except
 * for the missing `@` - and a reader scanning a thread cannot tell a routed
 * handoff from one that notified nobody. Muted weight and colour mark it as a
 * reference, and the permanently dotted underline keeps it legible as a link
 * without borrowing the solid-underline grammar of a delivered ask. Colour alone
 * proved too weak a signal: it is the one property the prose link rule overrides
 * (see PROSE_CLASSES in markdown-prose.tsx), so the decoration carries the
 * distinction even if a future blanket rule reaches the colour again.
 */
export const PASSIVE_MENTION_CLASSES =
	'font-medium text-[1.05em] text-neutral-soft-fg underline decoration-dotted decoration-1 underline-offset-[3px] hover:decoration-solid';

/**
 * In-app link to a specific comment in a task, scrolling straight to it via the
 * `#comment-<public_id>` hash. Shared by the markdown @mention renderer and the
 * agent-run formatted log view (bare/inline-code public_id references).
 */
export function CommentRefLink({
	taskIdentifier,
	commentId,
	projectSlug,
	taskTitle,
	children,
}: {
	taskIdentifier: string;
	commentId: string;
	projectSlug: string;
	taskTitle?: string;
	children: ReactNode;
}) {
	return (
		<Tooltip
			content={`Comment in ${taskIdentifier.toUpperCase()}${taskTitle ? ` — ${taskTitle}` : ''}`}
		>
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{ projectId: projectSlug, taskId: taskIdentifier.toLowerCase() }}
				hash={`comment-${commentId}`}
				className={MENTION_CLASSES}
				data-testid="comment-mention-link"
			>
				{children}
			</Link>
		</Tooltip>
	);
}
