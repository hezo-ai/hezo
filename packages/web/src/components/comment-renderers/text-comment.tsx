import { CommentAttachmentThumb } from '../comment-attachment-thumb';
import { MarkdownProse } from '../markdown-prose';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'text'>;
	projectId?: string;
	projectSlug?: string;
}

export function TextComment({ comment, projectId, projectSlug }: Props) {
	const raw = comment.content;
	const content =
		typeof raw === 'string'
			? raw
			: raw && typeof raw === 'object'
				? typeof raw.text === 'string'
					? raw.text
					: JSON.stringify(raw)
				: '';
	return (
		<>
			<MarkdownProse testId="text-comment-body" projectId={projectId} projectSlug={projectSlug}>
				{content}
			</MarkdownProse>
			{comment.attachments && comment.attachments.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-1.5" data-testid="comment-attachments">
					{comment.attachments.map((a) => (
						<CommentAttachmentThumb key={a.id} attachment={a} />
					))}
				</div>
			) : null}
		</>
	);
}
