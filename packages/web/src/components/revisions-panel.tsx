import { Clock, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { ConfirmDialog } from './ui/confirm-dialog';

export interface DocumentRevision {
	id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	author_name: string | null;
	created_at: string;
}

interface RevisionsPanelProps {
	revisions: DocumentRevision[] | undefined;
	onRestore: (revisionNumber: number) => Promise<unknown>;
	isRestoring?: boolean;
}

export function RevisionsPanel({ revisions, onRestore, isRestoring }: RevisionsPanelProps) {
	const [open, setOpen] = useState(false);
	const [pendingRestore, setPendingRestore] = useState<number | null>(null);

	return (
		<div className="mt-6 pt-4 border-t border-border-subtle">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-text mb-3"
			>
				<Clock className="w-3.5 h-3.5" />
				{open ? 'Hide' : 'Show'} revision history
				{revisions?.length ? ` (${revisions.length})` : ''}
			</button>

			{open && (
				<div className="space-y-2">
					{!revisions?.length ? (
						<p className="text-xs text-text-muted">No revisions yet.</p>
					) : (
						revisions.map((rev) => (
							<Card key={rev.id} className="p-3">
								<div className="flex items-center gap-2 mb-1">
									<span className="text-xs font-medium text-text">Rev {rev.revision_number}</span>
									<span className="text-xs text-text-muted">{rev.author_name || 'Board'}</span>
									<span className="text-xs text-text-subtle ml-auto">
										{new Date(rev.created_at).toLocaleString()}
									</span>
									<Button
										variant="ghost"
										size="sm"
										className="ml-1 text-xs"
										disabled={isRestoring}
										onClick={() => setPendingRestore(rev.revision_number)}
									>
										<RotateCcw className="w-3 h-3" /> Restore
									</Button>
								</div>
								{rev.change_summary && (
									<p className="text-xs text-text-muted">{rev.change_summary}</p>
								)}
							</Card>
						))
					)}
				</div>
			)}

			<ConfirmDialog
				open={pendingRestore !== null}
				onOpenChange={(next) => {
					if (!next) setPendingRestore(null);
				}}
				title={
					pendingRestore !== null ? `Restore to revision ${pendingRestore}?` : 'Restore revision'
				}
				description="The current content will be replaced with this revision."
				confirmLabel="Restore"
				loading={isRestoring}
				onConfirm={async () => {
					if (pendingRestore !== null) {
						await onRestore(pendingRestore);
						setPendingRestore(null);
					}
				}}
			/>
		</div>
	);
}
