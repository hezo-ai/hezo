import { jumpToComment } from './helpers';

/**
 * A comment's timestamp rendered as a self-anchor (`#comment-<public_id>`), so
 * every timeline row — text comments and inline events alike — exposes a
 * copy-able permalink that scrolls to and highlights itself. `stopPropagation`
 * keeps a click from reaching an enclosing control (the run row's expand
 * button wraps its timestamp); it's a no-op for the other call sites.
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
	return (
		<a
			href={`#comment-${publicId}`}
			onClick={(e) => {
				e.stopPropagation();
				jumpToComment(publicId)(e);
			}}
			className={`text-[11px] text-text-subtle hover:text-text hover:underline${className ? ` ${className}` : ''}`}
			title="Link to this comment"
			data-testid="comment-timestamp-link"
		>
			{new Date(createdAt).toLocaleString()}
		</a>
	);
}
