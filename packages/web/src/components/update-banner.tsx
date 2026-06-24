import { UpdateState } from '@hezo/shared';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../hooks/use-me';
import { useApplyUpdate, useDownloadUpdate, useUpdateStatus } from '../hooks/use-update-check';
import { ConfirmDialog } from './ui/confirm-dialog';
import { UpdateRestartOverlay } from './update-restart-overlay';

const DISMISS_KEY = 'hezo:update-dismissed';

function readDismissed(): string | null {
	try {
		return localStorage.getItem(DISMISS_KEY);
	} catch {
		return null;
	}
}

/**
 * Sticky bottom "update available" bar. When this instance can apply-and-restart
 * (a supervised compiled binary) and the caller is a superuser, it offers an
 * in-app "Update & restart" flow — staging the binary, then a confirmation that
 * warns about the master-key re-unlock, then the restart overlay. Otherwise it
 * falls back to a link to the GitHub Release. Dismissal is per-version.
 */
export function UpdateBanner() {
	const { data } = useUpdateStatus();
	const { data: me } = useMe();
	const download = useDownloadUpdate();
	const apply = useApplyUpdate();
	const [applying, setApplying] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [dismissed, setDismissed] = useState<string | null>(readDismissed);

	if (applying) {
		return <UpdateRestartOverlay targetVersion={data?.targetVersion ?? data?.latest ?? null} />;
	}

	if (!data?.updateAvailable || !data.latest || dismissed === data.latest) return null;

	const dismiss = () => {
		try {
			localStorage.setItem(DISMISS_KEY, data.latest as string);
		} catch {
			// ignore storage failures — banner just reappears next load
		}
		setDismissed(data.latest);
	};

	const canApply = data.canApply && me?.is_superuser === true;

	const confirmDescription = (
		<>
			Hezo will shut down and restart on <span className="font-medium">{data.latest}</span>.
			In-flight agent runs are paused and resume automatically.
			{!data.autoUnlock && (
				<>
					{' '}
					<span className="font-medium text-text-1">
						You'll need your 12-word master key to unlock Hezo again once it restarts.
					</span>
				</>
			)}
		</>
	);

	return (
		<div
			data-testid="update-banner"
			className="sticky bottom-0 z-40 flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-2 text-[13px] bg-surface border-t border-border text-text-1"
		>
			<span className="flex-1">
				Hezo <span className="font-medium">{data.latest}</span> is available — you're on{' '}
				{data.current}.
			</span>
			<div className="flex items-center gap-3">
				{canApply ? (
					data.state === UpdateState.Staged ? (
						<button
							type="button"
							data-testid="update-restart-button"
							onClick={() => setConfirmOpen(true)}
							className="font-medium text-inverse-fg bg-inverse hover:opacity-85 px-2.5 py-1 rounded-md"
						>
							Update &amp; restart
						</button>
					) : data.state === UpdateState.Downloading ? (
						<span className="text-text-2">Preparing update…</span>
					) : (
						<button
							type="button"
							data-testid="update-prepare-button"
							onClick={() => download.mutate()}
							disabled={download.isPending}
							className="font-medium text-text-1 hover:underline disabled:opacity-50"
						>
							{download.isPending ? 'Preparing…' : 'Prepare update'}
						</button>
					)
				) : (
					data.url && (
						<a
							href={data.url}
							target="_blank"
							rel="noreferrer"
							className="font-medium text-text-1 hover:underline"
						>
							Download
						</a>
					)
				)}
				<button
					type="button"
					onClick={dismiss}
					aria-label="Dismiss update notification"
					className="text-text-2 hover:text-text-1"
				>
					<X className="w-4 h-4" />
				</button>
			</div>

			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title="Update & restart Hezo?"
				description={confirmDescription}
				confirmLabel="Update & restart"
				onConfirm={async () => {
					await apply.mutateAsync();
					setApplying(true);
				}}
			/>
		</div>
	);
}
