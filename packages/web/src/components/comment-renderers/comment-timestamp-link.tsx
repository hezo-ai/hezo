import { useState } from 'react';
import { Tooltip } from '../ui/tooltip';
import { jumpToComment } from './helpers';

/**
 * A comment's timestamp rendered as a self-anchor (`#comment-<public_id>`), so
 * every timeline row — text comments and inline events alike — exposes a
 * copy-able permalink that scrolls to and highlights itself. `stopPropagation`
 * keeps a click from reaching an enclosing control (the run row's expand
 * button wraps its timestamp); it's a no-op for the other call sites.
 *
 * The label truncates (`min-w-0 truncate`) so the timestamp is the segment that
 * shrinks when the comment header runs out of horizontal room — on a narrow
 * mobile viewport this keeps the whole header on a single row instead of
 * wrapping. The full date/time is always reachable: on desktop it shows on
 * hover, and on touch a tap toggles the tooltip (Radix tooltips never open on
 * tap, so `open` is driven manually — `preventDefault` stops both the anchor
 * navigation and Radix's own pointer-down dismissal so the tap just reveals it).
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
	const full = new Date(createdAt).toLocaleString();
	return (
		<Tooltip content={full} open={open} onOpenChange={setOpen}>
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
				{full}
			</a>
		</Tooltip>
	);
}
