import { UpdateState } from '@hezo/shared';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useMe } from '../hooks/use-me';
import { useApplyUpdate, useDownloadUpdate, useUpdateStatus } from '../hooks/use-update-check';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { UpdateRestartOverlay } from './update-restart-overlay';

const DISMISS_KEY = 'hezo:update-dismissed';

interface Dismissal {
	version: string;
	day: string;
}

/** Local calendar-day key (YYYY-MM-DD in the viewer's timezone). */
function todayKey(): string {
	return new Date().toLocaleDateString('en-CA');
}

function readDismissed(): Dismissal | null {
	try {
		const raw = localStorage.getItem(DISMISS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<Dismissal>;
		if (typeof parsed?.version === 'string' && typeof parsed?.day === 'string') {
			return { version: parsed.version, day: parsed.day };
		}
		return null;
	} catch {
		// Unreadable storage or a legacy bare-version value → treat as not dismissed.
		return null;
	}
}

/**
 * Full-width "update available" banner pinned at the top of the shell, below the
 * nav and above content. When this instance can apply-and-restart (a supervised
 * compiled binary) and the caller is a superuser, a single "Download & Restart"
 * button stages the new binary then — after a confirmation that warns about the
 * master-key re-unlock — restarts onto it. Otherwise it falls back to a link to
 * the GitHub Release. Dismissal lasts until the next calendar day (or until a
 * newer version ships).
 */
export function UpdateBanner() {
	const { data } = useUpdateStatus();
	const { data: me } = useMe();
	const download = useDownloadUpdate();
	const apply = useApplyUpdate();
	const [applying, setApplying] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	// Set when the user clicks "Download & Restart" before the binary is staged, so
	// the confirmation opens automatically once staging finishes — one click, not two.
	const [restartIntent, setRestartIntent] = useState(false);
	const [dismissed, setDismissed] = useState<Dismissal | null>(readDismissed);

	const latest = data?.latest ?? null;
	const staged = data?.state === UpdateState.Staged;

	useEffect(() => {
		if (restartIntent && staged) {
			setConfirmOpen(true);
			setRestartIntent(false);
		}
	}, [restartIntent, staged]);

	if (applying) {
		return <UpdateRestartOverlay targetVersion={data?.targetVersion ?? data?.latest ?? null} />;
	}

	const isDismissed =
		dismissed !== null && dismissed.version === latest && dismissed.day === todayKey();
	if (!data?.updateAvailable || !latest || isDismissed) return null;

	const dismiss = () => {
		const record: Dismissal = { version: latest, day: todayKey() };
		try {
			localStorage.setItem(DISMISS_KEY, JSON.stringify(record));
		} catch {
			// ignore storage failures — banner just reappears next load
		}
		setDismissed(record);
	};

	const canApply = data.canApply && me?.is_superuser === true;
	const downloading = data.state === UpdateState.Downloading || download.isPending;

	// One-click "Download & Restart": stage the binary if needed, then surface the
	// restart confirmation. If it's already staged, jump straight to the confirm.
	const onDownloadAndRestart = () => {
		if (staged) {
			setConfirmOpen(true);
			return;
		}
		setRestartIntent(true);
		download.mutate();
	};

	const confirmDescription = (
		<>
			Hezo will shut down and restart on <span className="font-medium">{latest}</span>. In-flight
			agent runs are paused and resume automatically.
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
			className="shrink-0 flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-2.5 text-[13px] bg-accent-soft text-accent-soft-fg border-b border-border"
		>
			<span className="flex-1">
				Hezo <span className="font-semibold">{latest}</span> is available — you're on {data.current}
				.
			</span>
			<div className="flex items-center gap-2 sm:gap-3">
				{canApply ? (
					<Button
						type="button"
						variant="primary"
						size="sm"
						data-testid="update-restart-button"
						onClick={onDownloadAndRestart}
						disabled={downloading}
					>
						{downloading ? 'Preparing…' : 'Download & Restart'}
					</Button>
				) : (
					data.url && (
						<a
							href={data.url}
							target="_blank"
							rel="noreferrer"
							data-testid="update-download-link"
							className="inline-flex items-center justify-center whitespace-nowrap border border-transparent font-medium transition-colors h-[26px] px-2.5 text-[12.5px] rounded-sm bg-inverse text-inverse-fg hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring outline-none"
						>
							Download
						</a>
					)
				)}
				<button
					type="button"
					onClick={dismiss}
					aria-label="Dismiss update notification"
					className="text-accent-soft-fg/70 hover:text-accent-soft-fg"
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
