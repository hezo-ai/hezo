import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Copy } from 'lucide-react';
import { useState } from 'react';
import { useCreateCommentOnTask } from '../../hooks/use-comments';
import { toast } from '../../hooks/use-toast';
import { copyToClipboard } from '../../lib/clipboard';
import { Button } from '../ui/button';
import { DialogContent } from '../ui/dialog';
import { AddToTaskPicker } from './add-to-task-picker';
import { buildReviewHandoff } from './review-handoff';

/** Task context when the dialog is opened from a task view — pins that task first in the picker. */
export interface ReviewTaskContext {
	/** Route-param project slug (API path + query keys). */
	projectId: string;
	/** Route-param task id (lowercase identifier) — API path + query keys. */
	taskId: string;
	/** Uppercase display identifier, e.g. "HM-31". */
	identifier: string;
	/** Task title for the picker's pinned row. */
	title?: string;
}

interface ActionReviewDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Route-param project slug — scopes the "Add to task" picker's task list. */
	projectId: string;
	filename: string;
	commentCount: number;
	/** When set, the picker pins this task as its first entry. */
	task?: ReviewTaskContext;
	/** Override the handoff blurb (asset reviews); defaults to the doc handoff. */
	handoff?: string;
	/** What the agent reads the comments from — 'document' (default) or 'asset'. */
	sourceNoun?: string;
}

/**
 * "Action this review": hands the pending review to an agent. Shows the
 * admin-facing instructions and the handoff blurb — copyable, or postable as a
 * comment onto any of the project's tasks via the "Add to task" picker (the
 * hosting task leads the list when opened from a task view). The review
 * comments themselves stay in the database (agents read them via
 * read_project_doc). Either action closes the dialog on success.
 */
export function ActionReviewDialog({
	open,
	onOpenChange,
	projectId,
	filename,
	commentCount,
	task,
	handoff: handoffOverride,
	sourceNoun = 'document',
}: ActionReviewDialogProps) {
	const handoff = handoffOverride ?? buildReviewHandoff(filename);
	const createComment = useCreateCommentOnTask(projectId);
	const navigate = useNavigate();
	const [pickerOpen, setPickerOpen] = useState(false);

	function handleOpenChange(next: boolean) {
		if (!next) setPickerOpen(false);
		onOpenChange(next);
	}

	async function handleCopy() {
		const ok = await copyToClipboard(handoff);
		if (!ok) {
			toast.error('Failed to copy to clipboard');
			return;
		}
		handleOpenChange(false);
	}

	async function handleAdd(target: { taskId: string; identifier: string }) {
		try {
			const created = await createComment.mutateAsync({
				taskId: target.taskId,
				content: handoff,
			});
			// The comment landed on a different page, so the confirmation carries
			// the way there — deep-linked to the comment via the #comment-<id> hash.
			const taskId = target.identifier.toLowerCase();
			toast.success(`Handoff added to ${target.identifier}`, {
				link: {
					label: 'View comment',
					href: `/projects/${projectId}/tasks/${taskId}#comment-${created.public_id}`,
					onNavigate: () =>
						navigate({
							to: '/projects/$projectId/tasks/$taskId',
							params: { projectId, taskId },
							hash: `comment-${created.public_id}`,
						}),
				},
			});
			handleOpenChange(false);
		} catch (e) {
			// Close only the picker — the dialog stays so the handoff isn't lost.
			setPickerOpen(false);
			toast.error((e as Error).message || 'Failed to add comment');
		}
	}

	return (
		<Dialog.Root open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				size="md"
				data-testid="action-review-dialog"
				onEscapeKeyDown={(e) => {
					// Escape with the picker open closes just the picker.
					if (pickerOpen) {
						e.preventDefault();
						setPickerOpen(false);
					}
				}}
			>
				<Dialog.Title className="mb-3 pr-8 text-base font-semibold">
					Action this review
				</Dialog.Title>
				<Dialog.Description className="mb-3 text-[12.5px] leading-relaxed text-text-2">
					Add this handoff as a comment on a task - pick one from Add to task, or copy it - and
					assign it to the agent who should action the feedback. The agent reads the review comments
					directly from the {sourceNoun}.
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
					className="mt-3 flex items-center justify-between gap-2"
					data-testid="action-review-footer"
				>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleCopy}
						aria-label="Copy handoff"
						data-testid="action-review-copy"
					>
						<Copy className="h-3 w-3" />
						Copy
					</Button>
					<AddToTaskPicker
						projectId={projectId}
						currentTask={task}
						open={pickerOpen}
						onOpenChange={setPickerOpen}
						pending={createComment.isPending}
						pendingTaskId={
							createComment.isPending ? (createComment.variables?.taskId ?? null) : null
						}
						onSelect={handleAdd}
					/>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}
