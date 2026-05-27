import { CommentAttachmentThumb } from '../comment-attachment-thumb';
import { MarkdownProse } from '../markdown-prose';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'text'>;
	teamId?: string;
	projectSlug?: string;
}

export function TextComment({ comment, teamId, projectSlug }: Props) {
	const raw = comment.content;
	const content = raw?.text ?? (raw ? JSON.stringify(raw) : '');
	return (
		<>
			<MarkdownProse testId="text-comment-body" teamId={teamId} projectSlug={projectSlug}>
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
