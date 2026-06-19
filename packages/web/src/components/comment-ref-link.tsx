import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Tooltip } from './ui/tooltip';

/** Shared styling for every entity mention/reference link. */
export const MENTION_CLASSES = 'font-semibold text-[1.05em] text-info-soft-fg hover:underline';

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
