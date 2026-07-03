import * as Dialog from '@radix-ui/react-dialog';
import { Check, Eye, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import type { DocVersionEntry } from '../../lib/doc-version-history';
import { MarkdownProse } from '../markdown-prose';
import { ActorBadge } from '../ui/actor-badge';
import { Avatar, getInitials } from '../ui/avatar';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { dialogContentClassName, dialogOverlayClassName } from '../ui/dialog';

interface RevisionHistoryDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	filename: string;
	entries: DocVersionEntry[];
	projectId: string;
	projectSlug: string;
	/** null = viewing the latest version; a number = viewing that revision. */
	viewingRevision: number | null;
	/** Show that entry's content; `null` returns to the latest version. */
	onView: (entry: DocVersionEntry) => void;
	/** Admins only — omit to hide the Restore action. */
	onRestore?: (revisionNumber: number) => Promise<unknown>;
	isRestoring?: boolean;
}

function formatWhen(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

/**
 * The revision-history viewer for a project document: every version newest-first,
 * each rendered like a task comment (author, timestamp, and its changelog with
 * live @-mention/doc links). Selecting a version shows the document as it stood
 * then; admins can Restore a past version (which appends a new current version).
 */
export function RevisionHistoryDialog({
	open,
	onOpenChange,
	filename,
	entries,
	projectId,
	projectSlug,
	viewingRevision,
	onView,
	onRestore,
	isRestoring,
}: RevisionHistoryDialogProps) {
	const [pendingRestore, setPendingRestore] = useState<number | null>(null);

	const isShown = (e: DocVersionEntry) =>
		e.isCurrent ? viewingRevision === null : e.revisionNumber === viewingRevision;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content
					className={dialogContentClassName.lg}
					aria-describedby={undefined}
					data-testid="revision-history-dialog"
				>
					<div className="mb-4 flex items-center gap-2">
						<Dialog.Title className="text-base font-semibold">Revision history</Dialog.Title>
						<span className="font-mono text-[11px] text-text-3">
							{entries.length} {entries.length === 1 ? 'version' : 'versions'} · {filename}
						</span>
						<Dialog.Close asChild>
							<button
								type="button"
								className="-m-2 ml-auto p-2 text-text-2 hover:text-text-1"
								aria-label="Close"
							>
								<X className="h-4 w-4" />
							</button>
						</Dialog.Close>
					</div>

					<div className="flex flex-col gap-3">
						{entries.map((e) => {
							const author = e.authorName || 'Admin';
							const shown = isShown(e);
							return (
								<div key={e.revisionNumber ?? 'current'} className="flex gap-2.5">
									<Avatar initials={getInitials(author)} size="sm" />
									<div
										className={`min-w-0 flex-1 overflow-hidden rounded-md border bg-surface ${
											e.isCurrent ? 'border-accent-solid/45' : 'border-border'
										}`}
									>
										<div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-3 px-3 py-2">
											<span className="text-xs font-medium text-text-1">{author}</span>
											<ActorBadge actorType={e.authorType} name={e.authorName} />
											<span
												className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
													e.isCurrent
														? 'bg-accent-soft text-accent-soft-fg'
														: 'bg-surface-2 text-text-3'
												}`}
											>
												{e.isCurrent ? 'Current' : `Rev ${e.revisionNumber}`}
											</span>
											<span className="ml-auto text-[11px] tabular-nums text-text-3">
												{formatWhen(e.timestamp)}
											</span>
										</div>
										<div className="px-3 py-2.5">
											{e.isInitial || !e.changelog.trim() ? (
												<p className="text-xs italic text-text-3">
													Initial version — no changelog.
												</p>
											) : (
												<MarkdownProse projectId={projectId} projectSlug={projectSlug}>
													{e.changelog}
												</MarkdownProse>
											)}
										</div>
										<div className="flex items-center gap-1.5 px-3 pb-2.5">
											{shown ? (
												<span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-soft-fg">
													<Check className="h-3.5 w-3.5" /> Currently viewing
												</span>
											) : (
												<>
													<Button
														variant="outline"
														size="sm"
														onClick={() => onView(e)}
														data-testid="revision-view"
													>
														<Eye className="h-3.5 w-3.5" />
														{e.isCurrent ? 'View latest' : 'View this version'}
													</Button>
													{onRestore && !e.isCurrent && e.restoreRevisionNumber !== undefined && (
														<Button
															variant="ghost"
															size="sm"
															disabled={isRestoring}
															onClick={() => setPendingRestore(e.restoreRevisionNumber ?? null)}
															data-testid="revision-restore"
														>
															<RotateCcw className="h-3.5 w-3.5" /> Restore
														</Button>
													)}
												</>
											)}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</Dialog.Content>
			</Dialog.Portal>

			<ConfirmDialog
				open={pendingRestore !== null}
				onOpenChange={(next) => {
					if (!next) setPendingRestore(null);
				}}
				title={pendingRestore !== null ? `Restore revision ${pendingRestore}?` : 'Restore revision'}
				description="This brings that version's content back as a new current version. Earlier versions are kept."
				confirmLabel="Restore"
				loading={isRestoring}
				onConfirm={async () => {
					if (pendingRestore !== null && onRestore) {
						await onRestore(pendingRestore);
						setPendingRestore(null);
						onOpenChange(false);
					}
				}}
			/>
		</Dialog.Root>
	);
}
