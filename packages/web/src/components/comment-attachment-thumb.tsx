import { assetBasename } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import type { CommentAttachment } from '../hooks/use-comments';
import { AssetIcon } from './asset-icon';
import { Tooltip } from './ui/tooltip';

const THUMB_CLASSES =
	'flex h-9 w-9 items-center justify-center rounded-sm border border-border bg-surface-3 text-text-3 hover:border-border-strong hover:text-text-1';

export function CommentAttachmentThumb({
	attachment,
	projectId,
}: {
	attachment: CommentAttachment;
	/** Route-param project slug; when set the thumb opens the in-app viewer. */
	projectId?: string;
}) {
	// Attachments live under a library folder (uploads/<task-identifier>); the chip
	// shows just the file's name while the tooltip keeps the full path.
	const basename = assetBasename(attachment.original_filename);
	return (
		<Tooltip content={attachment.original_filename}>
			{projectId ? (
				<Link
					to="/projects/$projectId/assets/view"
					params={{ projectId }}
					search={{ file: attachment.original_filename }}
					aria-label={basename}
					data-testid="comment-attachment-thumb"
					data-filename={basename}
					className={THUMB_CLASSES}
				>
					<AssetIcon contentType={attachment.content_type} className="h-4 w-4" />
				</Link>
			) : (
				<a
					href={attachment.url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={basename}
					data-testid="comment-attachment-thumb"
					data-filename={basename}
					className={THUMB_CLASSES}
				>
					<AssetIcon contentType={attachment.content_type} className="h-4 w-4" />
				</a>
			)}
		</Tooltip>
	);
}
