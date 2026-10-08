import { CommentAttachmentThumb } from '../comment-attachment-thumb';
import { SummaryDetailsProse } from '../summary-details-prose';
import type { CommentDataOf } from './comment-data';
import { commentText } from './helpers';

interface Props {
	comment: CommentDataOf<'text'>;
	projectId?: string;
	projectSlug?: string;
}

export function TextComment({ comment, projectId, projectSlug }: Props) {
	const content = commentText(comment.content);
	return (
		<>
			<SummaryDetailsProse
				testId="text-comment-body"
				projectId={projectId}
				projectSlug={projectSlug}
			>
				{content}
			</SummaryDetailsProse>
			{comment.attachments && comment.attachments.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-1.5" data-testid="comment-attachments">
					{comment.attachments.map((a) => (
						<CommentAttachmentThumb key={a.id} attachment={a} projectId={projectId} />
					))}
				</div>
			) : null}
		</>
	);
}
