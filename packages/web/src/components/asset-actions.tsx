import {
	Archive,
	ArchiveRestore,
	Check,
	Copy,
	ExternalLink,
	FolderInput,
	Trash2,
} from 'lucide-react';
import { useCopyFeedback } from '../hooks/use-copy-feedback';
import type { ProjectAsset } from '../hooks/use-project-assets';
import { useI18n } from '../lib/i18n';
import { Tooltip } from './ui/tooltip';

const buttonClass = 'p-1 text-text-3 hover:text-text-1';

/**
 * Copies an asset's canonical `assets/<path>` reference — the exact string that
 * linkifies in comments and docs — to the clipboard, swapping its icon to a
 * check for 1.5s as confirmation (mirrors the comment/log copy affordances).
 */
function CopyReferenceButton({ reference }: { reference: string }) {
	const { t } = useI18n();
	const { copied, copy } = useCopyFeedback();

	return (
		<Tooltip content={copied ? t('common.copied') : t('assets.actions.copyLink')}>
			<button
				type="button"
				className={buttonClass}
				onClick={() => copy(reference)}
				aria-label={
					copied ? t('assets.actions.referenceCopied') : t('assets.actions.copyReference')
				}
				data-testid="asset-copy-link"
			>
				{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
			</button>
		</Tooltip>
	);
}

/**
 * The per-asset action buttons, shared by the grid card and the list row so the
 * two can never offer different affordances for the same asset.
 *
 * An archived asset swaps the reversible actions for Restore plus the hard
 * Delete — deleting is only ever reachable from the archived state, which is
 * what makes removing an asset for good a deliberate two-step.
 *
 * Every handler stops propagation: in the list these sit inside a row whose own
 * click opens the viewer.
 */
export function AssetActions({
	asset,
	onDelete,
	onMove,
	onArchive,
	onRestore,
}: {
	asset: ProjectAsset;
	onDelete: () => void;
	onMove: () => void;
	onArchive: () => void;
	onRestore: () => void;
}) {
	const { t } = useI18n();
	const isArchived = asset.archived_at != null;

	const act = (run: () => void) => (e: React.MouseEvent) => {
		e.stopPropagation();
		run();
	};

	return (
		<div className="flex shrink-0 items-center gap-0.5">
			<Tooltip content={t('assets.actions.openNewTab')}>
				<a
					href={asset.url}
					target="_blank"
					rel="noopener noreferrer"
					onClick={(e) => e.stopPropagation()}
					className={buttonClass}
					aria-label={t('assets.actions.openNewTab')}
					data-testid="asset-popout"
				>
					<ExternalLink className="h-3.5 w-3.5" />
				</a>
			</Tooltip>
			{isArchived ? (
				<>
					{/* Restore first; the hard delete only lives on archived assets -
					    active ones offer the reversible Archive instead. */}
					<Tooltip content={t('assets.actions.restore')}>
						<button
							type="button"
							className={buttonClass}
							onClick={act(onRestore)}
							aria-label={t('assets.actions.restore')}
							data-testid="asset-restore"
						>
							<ArchiveRestore className="h-3.5 w-3.5" />
						</button>
					</Tooltip>
					<Tooltip content={t('assets.actions.delete')}>
						<button
							type="button"
							className="p-1 text-text-3 hover:text-danger"
							onClick={act(onDelete)}
							aria-label={t('assets.actions.deleteLabel')}
							data-testid="asset-delete"
						>
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					</Tooltip>
				</>
			) : (
				<>
					<CopyReferenceButton reference={`assets/${asset.original_filename}`} />
					<Tooltip content={t('assets.actions.move')}>
						<button
							type="button"
							className={buttonClass}
							onClick={act(onMove)}
							aria-label={t('assets.actions.move')}
							data-testid="asset-move"
						>
							<FolderInput className="h-3.5 w-3.5" />
						</button>
					</Tooltip>
					<Tooltip content={t('assets.actions.archive')}>
						<button
							type="button"
							className={buttonClass}
							onClick={act(onArchive)}
							aria-label={t('assets.actions.archive')}
							data-testid="asset-archive"
						>
							<Archive className="h-3.5 w-3.5" />
						</button>
					</Tooltip>
				</>
			)}
		</div>
	);
}
