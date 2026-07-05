import { ClipboardCheck, MessageSquare, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useClearDocReviewComments, useDocReviewComments } from '../../hooks/use-doc-review';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip } from '../ui/tooltip';
import { ActionReviewDialog, type ReviewTaskContext } from './action-review-dialog';
import { ReviewHelp } from './review-help';

interface ReviewToolbarActionsProps {
	/** Route-param project slug (query keys + API paths). */
	projectId: string;
	filename: string;
	/** Task context when this toolbar renders inside a task view — enables "Add to <ID>" in the action dialog. */
	task?: ReviewTaskContext;
	/**
	 * `'grouped'` (default) wraps the controls in a tinted, rounded container so
	 * the review-comment tools read as one self-contained cluster, clearly set
	 * apart from the document-level actions (edit / delete / open-in-new-tab)
	 * sitting beside them in the same header. `'inline'` drops the container for
	 * surfaces that already supply their own (the standalone preview toolbar).
	 */
	variant?: 'grouped' | 'inline';
}

const ICON_BUTTON_CLASSES =
	'shrink-0 rounded-md p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1 disabled:pointer-events-none disabled:opacity-40';

/**
 * The review actions for a document view surface: comment count, "Action this
 * review" (agent handoff dialog), "Clear review" (confirm-gated delete of every
 * comment) and the "?" help affordance. These belong together as the document's
 * review-comment toolbar, kept visually distinct from the document's own
 * meta-level actions. Dropped into each surface's header/toolbar.
 */
export function ReviewToolbarActions({
	projectId,
	filename,
	task,
	variant = 'grouped',
}: ReviewToolbarActionsProps) {
	const { data: comments } = useDocReviewComments(projectId, filename);
	const clearMutation = useClearDocReviewComments(projectId, filename);
	const [actionOpen, setActionOpen] = useState(false);
	const [confirmClearOpen, setConfirmClearOpen] = useState(false);
	const count = comments?.length ?? 0;

	// Jump to the first review comment in the document. The highlights live in the
	// rendered body — a sibling surface, not a child of this toolbar — so reach
	// them through the document. `querySelector` returns the first match in
	// document order — the topmost comment; `block: 'center'` keeps it clear of the
	// sticky document-action header docked at the top of the scroller.
	function scrollToFirstComment() {
		const first = document.querySelector('mark[data-review-id]');
		first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	const containerClasses =
		variant === 'grouped'
			? 'flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface-2 px-1.5 py-0.5'
			: 'flex shrink-0 items-center gap-1';

	return (
		<div className={containerClasses} data-testid="review-toolbar">
			{count > 0 && (
				<Tooltip content="Jump to the first review comment">
					<button
						type="button"
						aria-label={`Jump to the first of ${count} review comment${count === 1 ? '' : 's'}`}
						data-testid="review-count-chip"
						onClick={scrollToFirstComment}
						className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-neutral-soft px-2 py-0.5 text-[11px] font-medium text-neutral-soft-fg transition-colors hover:bg-surface-3 hover:text-text-1"
					>
						<MessageSquare className="h-3 w-3" />
						{count}
					</button>
				</Tooltip>
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
			<ReviewHelp className="rounded-md p-1 leading-none hover:bg-surface-3" />
			<ActionReviewDialog
				open={actionOpen}
				onOpenChange={setActionOpen}
				filename={filename}
				commentCount={count}
				task={task}
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
