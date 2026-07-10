import { assetBasename } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { File, FileAudio, FileText, FileVideo, Image as ImageIcon } from 'lucide-react';
import type { CommentAttachment } from '../hooks/use-comments';
import { Tooltip } from './ui/tooltip';

function iconFor(contentType: string) {
	if (contentType.startsWith('image/')) return <ImageIcon className="h-4 w-4" />;
	if (contentType.startsWith('audio/')) return <FileAudio className="h-4 w-4" />;
	if (contentType.startsWith('video/')) return <FileVideo className="h-4 w-4" />;
	if (contentType === 'application/pdf' || contentType === 'text/plain') {
		return <FileText className="h-4 w-4" />;
	}
	return <File className="h-4 w-4" />;
}

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
					{iconFor(attachment.content_type)}
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
					{iconFor(attachment.content_type)}
				</a>
			)}
		</Tooltip>
	);
}
