import { useI18n } from '../../lib/i18n';
import { ConfirmDialog } from '../ui/confirm-dialog';

interface DeleteReviewCommentDialogProps {
	/** The comment a delete control asked about; the dialog is open while one is set. */
	comment: { id: string; comment: string } | null;
	onClose: () => void;
	/** Fire-and-forget: the delete is optimistic and reports its own failure. */
	onDelete: (commentId: string) => void;
}

/**
 * The confirmation every review-comment delete asks for, on documents and on
 * assets. The comment's own text leads the body, since a review can hold many
 * and the title cannot say which one.
 */
export function DeleteReviewCommentDialog({
	comment,
	onClose,
	onDelete,
}: DeleteReviewCommentDialogProps) {
	const { t } = useI18n();
	return (
		<ConfirmDialog
			open={comment !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t('review.deleteComment.title')}
			description={
				comment ? (
					<>
						<span
							className="block line-clamp-3 whitespace-pre-wrap text-text-1"
							data-testid="delete-review-comment-text"
						>
							{comment.comment}
						</span>
						<span className="mt-1 block">{t('review.deleteComment.description')}</span>
					</>
				) : (
					''
				)
			}
			confirmLabel={t('common.delete')}
			variant="danger"
			onConfirm={() => {
				if (comment) onDelete(comment.id);
			}}
		/>
	);
}
