import type { ProjectAsset } from '@hezo/shared';
import { ClipboardCheck, MessageSquare, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AssetReviewComment } from '../../hooks/use-asset-review';
import { toast } from '../../hooks/use-toast';
import { ActionReviewDialog } from '../document-review/action-review-dialog';
import { buildAssetReviewHandoff } from '../document-review/review-handoff';
import { ReviewHelp } from '../document-review/review-help';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip } from '../ui/tooltip';

const ICON_BUTTON_CLASSES =
	'shrink-0 rounded-md p-1 text-text-3 transition-colors hover:bg-surface-3 hover:text-text-1 disabled:pointer-events-none disabled:opacity-40';

interface AssetReviewPanelProps {
	/** Route-param project slug. */
	projectId: string;
	/** The asset's path (the `?file` route value). */
	file: string;
	asset: ProjectAsset;
	/** Archived assets: the review is visible but frozen. */
	readOnly: boolean;
	/** Text assets anchor via selection on the left pane; others comment here. */
	textAnchored: boolean;
	comments: AssetReviewComment[] | undefined;
	creating: boolean;
	activeId: string | null;
	onActiveIdChange: (id: string | null) => void;
	onCreateWholeAsset: (text: string) => Promise<void>;
	onUpdate: (commentId: string, text: string) => void;
	onDelete: (commentId: string) => void;
	onClearAll: () => Promise<void>;
}

/**
 * The viewer's right pane: the asset's review comments as a list. Clicking a
 * row reveals its anchor on the left pane (text anchors scroll to and light up
 * their highlight; whole-asset comments just activate). The header carries the
 * same review actions documents have — count, "Action this review" handoff,
 * clear, help — and non-text assets compose their whole-asset comments here.
 */
export function AssetReviewPanel({
	projectId,
	file,
	asset,
	readOnly,
	textAnchored,
	comments,
	creating,
	activeId,
	onActiveIdChange,
	onCreateWholeAsset,
	onUpdate,
	onDelete,
	onClearAll,
}: AssetReviewPanelProps) {
	const [actionOpen, setActionOpen] = useState(false);
	const [confirmClearOpen, setConfirmClearOpen] = useState(false);
	const [composerOpen, setComposerOpen] = useState(false);
	const [composerText, setComposerText] = useState('');
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingText, setEditingText] = useState('');
	const count = comments?.length ?? 0;

	function reveal(comment: AssetReviewComment) {
		onActiveIdChange(comment.id);
		if (comment.quote !== null) {
			document
				.querySelector(`mark[data-review-id="${comment.id}"]`)
				?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}

	function scrollToFirstComment() {
		const first = comments?.[0];
		if (first) reveal(first);
	}

	async function saveComposer() {
		try {
			await onCreateWholeAsset(composerText);
			setComposerOpen(false);
			setComposerText('');
		} catch (e) {
			toast.error((e as Error).message || 'Failed to add comment');
		}
	}

	function startEdit(comment: AssetReviewComment) {
		setEditingId(comment.id);
		setEditingText(comment.comment);
	}

	function saveEdit() {
		if (!editingId || editingText.trim() === '') return;
		onUpdate(editingId, editingText);
		setEditingId(null);
	}

	return (
		<div data-testid="asset-review-panel">
			<div className="mb-3 flex items-center justify-between gap-1">
				<h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-text-1">
					Review
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
				</h2>
				<div className="flex items-center gap-0.5">
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
							disabled={count === 0 || readOnly}
							onClick={() => setConfirmClearOpen(true)}
						>
							<Trash2 className="h-4 w-4" />
						</button>
					</Tooltip>
					<ReviewHelp subject="asset" className="rounded-md p-1 leading-none hover:bg-surface-3" />
				</div>
			</div>

			{!textAnchored && !readOnly && (
				<div className="mb-3">
					{composerOpen ? (
						<div className="rounded-md border border-border bg-surface p-2">
							<textarea
								value={composerText}
								onChange={(e) => setComposerText(e.target.value)}
								placeholder="Leave a comment on this asset..."
								data-testid="asset-review-composer"
								// biome-ignore lint/a11y/noAutofocus: the composer opens from an explicit click; focusing it is the expected next step
								autoFocus
								className="block h-[70px] w-full resize-none rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] leading-snug text-text-1 outline-none focus:border-accent focus:ring-[3px] focus:ring-ring"
							/>
							<div className="mt-2 flex items-center justify-end gap-1.5">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setComposerOpen(false);
										setComposerText('');
									}}
								>
									Cancel
								</Button>
								<Button
									variant="primary"
									size="sm"
									disabled={composerText.trim() === '' || creating}
									onClick={saveComposer}
									data-testid="asset-review-composer-save"
								>
									Save
								</Button>
							</div>
						</div>
					) : (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => setComposerOpen(true)}
							data-testid="asset-review-composer-open"
						>
							<MessageSquarePlus className="h-3.5 w-3.5" />
							Comment on this asset
						</Button>
					)}
				</div>
			)}

			{count === 0 ? (
				<p className="text-[12.5px] leading-relaxed text-text-3" data-testid="asset-review-empty">
					{readOnly
						? 'The review is frozen while the asset is archived.'
						: textAnchored
							? 'Select text in the asset (or hover a line) to leave the first comment.'
							: 'No review comments yet.'}
				</p>
			) : (
				<ul className="space-y-2">
					{(comments ?? []).map((c) => (
						<li key={c.id}>
							<div
								data-testid="asset-review-row"
								data-active={c.id === activeId || undefined}
								className={`w-full rounded-md border p-2 text-left transition-colors ${
									c.id === activeId
										? 'border-accent bg-accent/5'
										: 'border-border bg-surface hover:border-border-strong'
								}`}
							>
								<button
									type="button"
									onClick={() => reveal(c)}
									className="block w-full cursor-pointer text-left"
									aria-label={
										c.quote !== null ? 'Show this comment in the asset' : 'Select this comment'
									}
								>
									{c.quote !== null ? (
										<div
											className="mb-1 truncate rounded-r border-l-2 border-accent/45 bg-accent/10 px-2 py-0.5 text-xs italic text-text-2"
											title={c.quote}
										>
											“{c.quote}”
										</div>
									) : (
										<div className="text-eyebrow mb-1 text-text-3">Whole asset</div>
									)}
									{editingId !== c.id && (
										<div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-text-1">
											{c.comment}
										</div>
									)}
								</button>
								{editingId === c.id ? (
									<div className="mt-1">
										<textarea
											value={editingText}
											onChange={(e) => setEditingText(e.target.value)}
											data-testid="asset-review-edit-textarea"
											// biome-ignore lint/a11y/noAutofocus: editing starts from an explicit click on the pencil
											autoFocus
											className="block h-[60px] w-full resize-none rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] leading-snug text-text-1 outline-none focus:border-accent focus:ring-[3px] focus:ring-ring"
										/>
										<div className="mt-1.5 flex items-center justify-end gap-1.5">
											<Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
												Cancel
											</Button>
											<Button
												variant="primary"
												size="sm"
												disabled={editingText.trim() === ''}
												onClick={saveEdit}
												data-testid="asset-review-edit-save"
											>
												Save
											</Button>
										</div>
									</div>
								) : (
									!readOnly && (
										<div className="mt-1 flex items-center justify-end gap-0.5">
											<Tooltip content="Edit comment">
												<button
													type="button"
													aria-label="Edit comment"
													data-testid="asset-review-edit"
													className={ICON_BUTTON_CLASSES}
													onClick={() => startEdit(c)}
												>
													<Pencil className="h-3.5 w-3.5" />
												</button>
											</Tooltip>
											<Tooltip content="Delete comment">
												<button
													type="button"
													aria-label="Delete comment"
													data-testid="asset-review-delete"
													className={ICON_BUTTON_CLASSES}
													onClick={() => onDelete(c.id)}
												>
													<Trash2 className="h-3.5 w-3.5" />
												</button>
											</Tooltip>
										</div>
									)
								)}
							</div>
						</li>
					))}
				</ul>
			)}

			<ActionReviewDialog
				open={actionOpen}
				onOpenChange={setActionOpen}
				projectId={projectId}
				filename={`assets/${file}`}
				commentCount={count}
				handoff={buildAssetReviewHandoff(file)}
				sourceNoun="asset"
			/>
			<ConfirmDialog
				open={confirmClearOpen}
				onOpenChange={setConfirmClearOpen}
				title="Clear review?"
				description={`Deletes all ${count} review comment${count === 1 ? '' : 's'} on ${asset.original_filename}. This cannot be undone.`}
				confirmLabel="Clear review"
				variant="danger"
				onConfirm={async () => {
					await onClearAll();
				}}
			/>
		</div>
	);
}
