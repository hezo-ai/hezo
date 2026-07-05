import * as Dialog from '@radix-ui/react-dialog';
import { Copy, Loader2 } from 'lucide-react';
import { useCreateComment } from '../../hooks/use-comments';
import { toast } from '../../hooks/use-toast';
import { copyToClipboard } from '../../lib/clipboard';
import { Button } from '../ui/button';
import { DialogContent } from '../ui/dialog';
import { buildReviewHandoff } from './review-handoff';

/** Task context for the "Add to <ID>" action — present only when the dialog is opened from a task view. */
export interface ReviewTaskContext {
	/** Route-param project slug (API path + query keys). */
	projectId: string;
	/** Route-param task id (lowercase identifier) — API path + query keys. */
	taskId: string;
	/** Uppercase display identifier, e.g. "HM-31" — the button label. */
	identifier: string;
}

interface ActionReviewDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	filename: string;
	commentCount: number;
	/** When set, renders "Add to <identifier>" which posts the handoff as a comment on that task. */
	task?: ReviewTaskContext;
}

/**
 * "Action this review": hands the pending review to an agent. Shows the
 * admin-facing instructions and the handoff blurb — copyable everywhere, and
 * postable straight onto the hosting task as a comment when opened from a task
 * view. The review comments themselves stay in the database (agents read them
 * via read_project_doc). Either action closes the dialog on success.
 */
export function ActionReviewDialog({
	open,
	onOpenChange,
	filename,
	commentCount,
	task,
}: ActionReviewDialogProps) {
	const handoff = buildReviewHandoff(filename);
	// Inert until fired — the Add button only renders (and handleAdd only runs)
	// when `task` is set, so the empty-string fallback never reaches the API.
	const createComment = useCreateComment(task?.projectId ?? '', task?.taskId ?? '');

	async function handleCopy() {
		const ok = await copyToClipboard(handoff);
		if (!ok) {
			toast.error('Failed to copy to clipboard');
			return;
		}
		onOpenChange(false);
	}

	async function handleAdd() {
		if (!task) return;
		try {
			await createComment.mutateAsync({ content: handoff });
			onOpenChange(false);
		} catch (e) {
			toast.error((e as Error).message || 'Failed to add comment');
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md" data-testid="action-review-dialog">
				<Dialog.Title className="mb-3 pr-8 text-base font-semibold">
					Action this review
				</Dialog.Title>
				<Dialog.Description className="mb-3 text-[12.5px] leading-relaxed text-text-2">
					{task
						? `Add this handoff as a comment on ${task.identifier} — or copy it for another task — and assign it to the agent who should action the feedback. The agent reads the review comments directly from the document.`
						: "Paste this handoff into a task comment — or a new task's description — and assign it to the agent who should action the feedback. The agent reads the review comments directly from the document."}
				</Dialog.Description>
				<div
					className="whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 text-[12.5px] leading-relaxed text-text-1"
					data-testid="action-review-handoff"
				>
					{handoff}
				</div>
				<div className="mt-4 min-w-0 truncate text-xs text-text-3" data-testid="action-review-meta">
					{commentCount} comment{commentCount === 1 ? '' : 's'} · {filename}
				</div>
				<div
					className={`mt-3 flex items-center gap-2 ${task ? 'justify-between' : 'justify-center'}`}
					data-testid="action-review-footer"
				>
					<Button
						size="sm"
						variant={task ? 'secondary' : 'primary'}
						onClick={handleCopy}
						aria-label="Copy handoff"
						data-testid="action-review-copy"
					>
						<Copy className="h-3 w-3" />
						Copy
					</Button>
					{task && (
						<Button
							size="sm"
							onClick={handleAdd}
							disabled={createComment.isPending}
							aria-label={`Add to ${task.identifier}`}
							data-testid="action-review-add"
						>
							{createComment.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
							Add to {task.identifier}
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}
