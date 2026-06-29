import { UpdateState } from '@hezo/shared';
import { X } from 'lucide-react';
import { useState } from 'react';
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
 * nav and above content. The server downloads and stages the new binary in the
 * background; when this instance can apply-and-restart (a supervised compiled
 * binary), the caller is a superuser, and the binary is staged, an "Install &
 * restart" button — after a confirmation that warns about the master-key
 * re-unlock — restarts onto it instantly. The new version number links to its
 * GitHub release page so the user can read the release notes. While the
 * background download is still
 * in flight the banner stays hidden; if staging errored on a self-applying
 * instance it offers a "Retry download" button (with the GitHub Release as a
 * secondary link), and for any instance that can't self-apply it falls back to the
 * release link. Dismissal lasts until the next calendar day (or a newer version ships).
 */
export function UpdateBanner() {
	const { data } = useUpdateStatus();
	const { data: me } = useMe();
	const apply = useApplyUpdate();
	const download = useDownloadUpdate();
	const [applying, setApplying] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [dismissed, setDismissed] = useState<Dismissal | null>(readDismissed);

	const latest = data?.latest ?? null;
	const staged = data?.state === UpdateState.Staged;
	const errored = data?.state === UpdateState.Error;

	if (applying) {
		return <UpdateRestartOverlay targetVersion={data?.targetVersion ?? data?.latest ?? null} />;
	}

	const isDismissed =
		dismissed !== null && dismissed.version === latest && dismissed.day === todayKey();
	if (!data?.updateAvailable || !latest || isDismissed) return null;

	const canApply = data.canApply && me?.is_superuser === true;
	// While the server is still downloading/staging in the background there's
	// nothing actionable yet — stay hidden until it's staged (or has errored, in
	// which case we surface the release-page link below).
	if (canApply && !staged && !errored) return null;

	const dismiss = () => {
		const record: Dismissal = { version: latest, day: todayKey() };
		try {
			localStorage.setItem(DISMISS_KEY, JSON.stringify(record));
		} catch {
			// ignore storage failures — banner just reappears next load
		}
		setDismissed(record);
	};

	// Instant restart only once the binary is staged. A self-applying instance whose
	// staging errored can re-trigger the background download; otherwise (can't
	// self-apply) fall back to the release-page download.
	const showInstall = canApply && staged;
	const showRetry = canApply && !staged && errored;

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
				Hezo{' '}
				{data.url ? (
					<a
						href={data.url}
						target="_blank"
						rel="noreferrer"
						data-testid="update-version-link"
						className="font-semibold underline underline-offset-2 hover:no-underline"
					>
						{latest}
					</a>
				) : (
					<span className="font-semibold">{latest}</span>
				)}{' '}
				is available — you're on {data.current}.
			</span>
			<div className="flex items-center gap-2 sm:gap-3">
				{showInstall ? (
					<Button
						type="button"
						variant="primary"
						size="sm"
						data-testid="update-restart-button"
						onClick={() => setConfirmOpen(true)}
					>
						Install & restart
					</Button>
				) : showRetry ? (
					<>
						<Button
							type="button"
							variant="primary"
							size="sm"
							data-testid="update-retry-button"
							disabled={download.isPending}
							onClick={() => download.mutate()}
						>
							{download.isPending ? 'Downloading…' : 'Retry download'}
						</Button>
						{data.url && (
							<a
								href={data.url}
								target="_blank"
								rel="noreferrer"
								data-testid="update-download-link"
								className="underline underline-offset-2 hover:no-underline"
							>
								Download manually
							</a>
						)}
					</>
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
				title="Install & restart Hezo?"
				description={confirmDescription}
				confirmLabel="Install & restart"
				onConfirm={async () => {
					await apply.mutateAsync();
					setApplying(true);
				}}
			/>
		</div>
	);
}
