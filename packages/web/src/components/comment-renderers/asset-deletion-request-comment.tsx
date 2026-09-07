import { Link } from '@tanstack/react-router';
import { Check, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useResolveAssetDeletion } from '../../hooks/use-comments';
import { useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { ConfirmDialog } from '../ui/confirm-dialog';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'asset_deletion_request'>;
	projectId?: string;
	taskId?: string;
}

/**
 * An agent-filed asset-deletion approval card. Deletion is destructive and
 * admin-gated: the agent can only request; a human approves (the backend
 * deletes the assets) or denies. Mirrors the credential-request card's
 * pending/resolved shape; the resolve mutation is response-driven, never
 * optimistic.
 */
export function AssetDeletionRequestComment({ comment, projectId, taskId }: Props) {
	const { t } = useI18n();
	const content = comment.content ?? {};
	const assets = Array.isArray(content.assets) ? content.assets : [];
	const reason = content.reason ?? '';
	const chosen = comment.chosen_option;
	const resolve = useResolveAssetDeletion(projectId ?? '', taskId ?? '');
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!projectId || !taskId) {
		return (
			<p className="text-xs text-text-3 italic">Asset deletion request unavailable in this view.</p>
		);
	}

	if (chosen) {
		const approved = chosen.status === 'approved';
		const deletedCount = chosen.deleted_asset_ids?.length ?? 0;
		return (
			// The tone is the outcome, so it is a prop rather than a second class
			// string. `role="none"`: a thread renders many of these at once, and the
			// thread is what a reader follows - one live region per card is noise.
			<Callout
				tone={approved ? 'success' : 'neutral'}
				role="none"
				className={approved ? 'border border-success' : 'border border-border'}
				icon={approved ? <Check className="w-4 h-4" /> : <X className="w-4 h-4 text-text-3" />}
				data-testid={approved ? 'asset-deletion-approved' : 'asset-deletion-denied'}
			>
				<div>
					<p className="text-sm font-medium text-text-1">
						{approved
							? `Deletion approved - ${deletedCount} asset${deletedCount === 1 ? '' : 's'} deleted`
							: 'Deletion denied - assets kept'}
					</p>
					<p className="text-xs text-text-2 mt-0.5">
						{assets.map((a) => `assets/${a.path}`).join(', ')}
					</p>
				</div>
			</Callout>
		);
	}

	const submit = (approve: boolean) => {
		setError(null);
		resolve.mutate(
			{ commentId: comment.id, approve },
			{
				onError: (e: unknown) => {
					setError(e instanceof Error ? e.message : 'Failed to resolve the request');
				},
			},
		);
	};

	return (
		<div
			className="flex flex-col gap-2 p-2.5 rounded-lg border border-danger/50 bg-danger/5"
			data-testid="asset-deletion-request"
		>
			<div className="flex items-start gap-2">
				<Trash2 className="w-4 h-4 text-danger shrink-0 mt-0.5" />
				<div className="flex-1 min-w-0">
					<p className="text-sm font-medium text-text-1">
						Agent requests deletion of {assets.length} asset{assets.length === 1 ? '' : 's'}
					</p>
					<ul className="mt-1 flex flex-col gap-0.5">
						{assets.map((a) => (
							<li key={a.id} className="min-w-0">
								<Link
									to="/projects/$projectId/assets"
									params={{ projectId }}
									search={{ file: a.path }}
									className="block truncate font-mono text-xs text-info-soft-fg hover:underline"
									data-testid="asset-deletion-asset-link"
								>
									assets/{a.path}
								</Link>
							</li>
						))}
					</ul>
					{reason && (
						<p className="text-xs text-text-2 mt-1.5" data-testid="asset-deletion-reason">
							{reason}
						</p>
					)}
				</div>
			</div>
			{error && <p className="pl-6 text-xs text-danger-soft-fg">{error}</p>}
			<div className="flex items-center gap-2 pl-6">
				<Button
					size="sm"
					variant="destructive"
					onClick={() => setConfirmOpen(true)}
					disabled={resolve.isPending}
					data-testid="asset-deletion-approve"
				>
					Approve deletion
				</Button>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => submit(false)}
					disabled={resolve.isPending}
					data-testid="asset-deletion-deny"
				>
					Deny
				</Button>
			</div>
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={`Permanently delete ${assets.length} asset${assets.length === 1 ? '' : 's'}?`}
				description="Comments that attach or reference them will lose the file. This cannot be undone."
				confirmLabel={t('common.delete')}
				variant="danger"
				loading={resolve.isPending}
				onConfirm={() => submit(true)}
			/>
		</div>
	);
}
