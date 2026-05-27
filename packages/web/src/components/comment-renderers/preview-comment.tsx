import { ExternalLink } from 'lucide-react';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'preview'>;
}

export function PreviewComment({ comment }: Props) {
	const url = comment.content?.url || comment.content?.preview_url || '';
	const title = comment.content?.title || 'Preview';

	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1.5 text-sm text-accent-blue-text hover:underline"
		>
			<ExternalLink className="w-3.5 h-3.5" />
			{title}
		</a>
	);
}
