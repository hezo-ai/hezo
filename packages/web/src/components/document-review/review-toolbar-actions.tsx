import { ClipboardCheck, MessageSquare, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useClearDocReviewComments, useDocReviewComments } from '../../hooks/use-doc-review';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip } from '../ui/tooltip';
import { ActionReviewDialog } from './action-review-dialog';

interface ReviewToolbarActionsProps {
	/** Route-param project slug (query keys + API paths). */
	projectId: string;
	filename: string;
}

const ICON_BUTTON_CLASSES =
	'shrink-0 rounded-md p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1 disabled:pointer-events-none disabled:opacity-40';

/**
 * The review actions for a document view surface: comment count, "Action this
 * review" (agent handoff dialog) and "Clear review" (confirm-gated delete of
 * every comment). Dropped into each surface's header/toolbar.
 */
export function ReviewToolbarActions({ projectId, filename }: ReviewToolbarActionsProps) {
	const { data: comments } = useDocReviewComments(projectId, filename);
	const clearMutation = useClearDocReviewComments(projectId, filename);
	const [actionOpen, setActionOpen] = useState(false);
	const [confirmClearOpen, setConfirmClearOpen] = useState(false);
	const count = comments?.length ?? 0;

	return (
		<div className="flex shrink-0 items-center gap-1">
			{count > 0 && (
				<span
					className="inline-flex items-center gap-1 rounded-full bg-neutral-soft px-2 py-0.5 text-[11px] font-medium text-neutral-soft-fg"
					data-testid="review-count-chip"
					title={`${count} review comment${count === 1 ? '' : 's'}`}
				>
					<MessageSquare className="h-3 w-3" />
					{count}
				</span>
			)}
			<Tooltip content="Action this review — copy a handoff for an agent">
				<button
					type="button"
					aria-label="Action this review"
					data-testid="review-action-open"
					className={ICON_BUTTON_CLASSES}
					disabled={count === 0}
					onClick={() => setActionOpen(true)}
				>
					<ClipboardCheck className="h-4 w-4" />
				</button>
			</Tooltip>
			<Tooltip content="Clear review (deletes all comments)">
				<button
					type="button"
					aria-label="Clear review"
					data-testid="review-clear"
					className={ICON_BUTTON_CLASSES}
					disabled={count === 0}
					onClick={() => setConfirmClearOpen(true)}
				>
					<Trash2 className="h-4 w-4" />
				</button>
			</Tooltip>
			<ActionReviewDialog
				open={actionOpen}
				onOpenChange={setActionOpen}
				filename={filename}
				commentCount={count}
			/>
			<ConfirmDialog
				open={confirmClearOpen}
				onOpenChange={setConfirmClearOpen}
				title="Clear review?"
				description={`Deletes all ${count} review comment${count === 1 ? '' : 's'} on ${filename}. This cannot be undone.`}
				confirmLabel="Clear review"
				variant="danger"
				onConfirm={async () => {
					await clearMutation.mutateAsync();
				}}
			/>
		</div>
	);
}
