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

export function CommentAttachmentThumb({ attachment }: { attachment: CommentAttachment }) {
	return (
		<Tooltip content={attachment.original_filename}>
			<a
				href={attachment.url}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={attachment.original_filename}
				data-testid="comment-attachment-thumb"
				data-filename={attachment.original_filename}
				className="flex h-9 w-9 items-center justify-center rounded-radius-sm border border-border bg-bg-muted text-text-subtle hover:border-border-hover hover:text-text"
			>
				{iconFor(attachment.content_type)}
			</a>
		</Tooltip>
	);
}
