import { useState } from 'react';
import { formatDateTime, formatRelativeTime } from '../../lib/format-date';
import { Tooltip } from '../ui/tooltip';
import { jumpToComment } from './helpers';

/**
 * A comment's timestamp rendered as a self-anchor (`#comment-<public_id>`), so
 * every timeline row — text comments and inline events alike — exposes a
 * copy-able permalink that scrolls to and highlights itself. `stopPropagation`
 * keeps a click from reaching an enclosing control (the run row's expand
 * button wraps its timestamp); it's a no-op for the other call sites.
 *
 * The visible label is a relative "X ago" phrase (an absolute date once the
 * comment is older than a week); the exact date/time is always reachable via the
 * tooltip. The label truncates (`min-w-0 truncate`) so the timestamp is the
 * segment that shrinks when the comment header runs out of horizontal room — on
 * a narrow mobile viewport this keeps the whole header on a single row instead
 * of wrapping. The tooltip shows on hover (desktop), and on touch a tap toggles
 * it (Radix tooltips never open on tap, so `open` is driven manually —
 * `preventDefault` stops both the anchor navigation and Radix's own pointer-down
 * dismissal so the tap just reveals it).
 */
export function CommentTimestampLink({
	publicId,
	createdAt,
	className,
}: {
	publicId: string;
	createdAt: string;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Tooltip content={formatDateTime(createdAt)} open={open} onOpenChange={setOpen}>
			<a
				href={`#comment-${publicId}`}
				onClick={(e) => {
					e.stopPropagation();
					jumpToComment(publicId)(e);
				}}
				onTouchStart={(e) => {
					e.preventDefault();
					setOpen((o) => !o);
				}}
				className={`min-w-0 truncate text-[11px] text-text-3 hover:text-text-1 hover:underline${className ? ` ${className}` : ''}`}
				title="Link to this comment"
				data-testid="comment-timestamp-link"
			>
				{formatRelativeTime(createdAt)}
			</a>
		</Tooltip>
	);
}
