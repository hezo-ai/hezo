import { UpdateState } from '@hezo/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../hooks/use-me';
import {
	useApplyUpdate,
	useCheckForUpdate,
	useDownloadUpdate,
	useUpdateStatus,
} from '../hooks/use-update-check';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { UpdateRestartOverlay } from './update-restart-overlay';

/** Release tags are plain `MAJOR.MINOR.PATCH` (no `v` prefix) — only those have a GitHub tag page. */
const RELEASE_TAG = /^\d+\.\d+\.\d+$/;

const RELEASES_URL = 'https://github.com/hezo-ai/hezo/releases';

/**
 * Version section at the bottom of the General settings page: the running version
 * (linked to its GitHub release page) plus a "Check for new version" button that
 * forces the same GitHub update check the daily cron runs.
 *
 * When an update is available this section mirrors the top-of-shell update banner
 * in place — surfacing the live staged-update lifecycle. On a self-applying
 * instance (supervised compiled binary) for a superuser it shows "Downloading new
 * version…" while the background download/verify/stage runs, then flips to an
 * "Install & restart" button (with the same restart confirmation) once staged, or a
 * "Retry download" if staging errored. Any instance that can't update in place
 * falls back to a "Download" link to the GitHub release. `useUpdateStatus({ poll })`
 * refetches while a download is in flight so the transition is live, no reload.
 */
export function VersionDisplay() {
	const { t } = useI18n();
	const { data: update } = useUpdateStatus({ poll: true });
	const { data: me } = useMe();
	const check = useCheckForUpdate();
	const apply = useApplyUpdate();
	const download = useDownloadUpdate();
	const [applying, setApplying] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);

	if (applying) {
		return <UpdateRestartOverlay fromVersion={update?.current ?? null} />;
	}

	if (!update?.current) return null;

	const current = update.current;
	const isReleaseTag = RELEASE_TAG.test(current);
	const releaseUrl = isReleaseTag ? `${RELEASES_URL}/tag/${current}` : RELEASES_URL;

	const updateAvailable = update.updateAvailable && !!update.latest;
	const latest = update.latest;
	const downloadUrl = update.url ?? RELEASES_URL;
	// A self-applying instance (supervised compiled binary) whose caller is a superuser.
	const canApply = update.canApply && me?.is_superuser === true;
	const staged = update.state === UpdateState.Staged;
	const errored = update.state === UpdateState.Error;
	// canApply and not yet staged (and not errored) → the background download is in flight.
	const downloading = canApply && !staged && !errored;

	const confirmDescription = (
		<>
			Hezo will shut down and restart on <span className="font-medium">{latest}</span>. In-flight
			agent runs are paused and resume automatically.
			{!update.autoUnlock && (
				<>
					{' '}
					<span className="font-medium text-text-1">{t('updates.confirm.reunlock')}</span>
				</>
			)}
		</>
	);

	return (
		<section className="mt-8" data-testid="settings-version">
			<div className="mb-4">
				<h2 className="text-base font-medium">Version</h2>
				<p className="text-[13px] text-text-2 mt-1">
					The version of Hezo this instance is running. Check for new releases on GitHub.
				</p>
			</div>
			<div className="border border-border rounded-md p-3 bg-surface">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="text-[13px]">
						<span className="text-text-2">Current version:</span>{' '}
						<a
							href={releaseUrl}
							target="_blank"
							rel="noreferrer"
							className="font-medium text-text-1 hover:underline"
							data-testid="settings-version-current"
						>
							{current}
						</a>
					</div>
					<Button
						size="sm"
						variant="secondary"
						onClick={() => check.mutate()}
						disabled={check.isPending}
						data-testid="settings-version-check"
						className="self-start sm:self-auto"
					>
						{check.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Check for new version
					</Button>
				</div>

				{check.isError ? (
					<p className="text-[13px] text-danger mt-2.5" data-testid="settings-version-error">
						Couldn't check for updates. Please try again.
					</p>
				) : updateAvailable ? (
					<div
						className="mt-2.5 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between"
						data-testid="settings-version-result"
						aria-live="polite"
					>
						<p className="text-[13px] text-text-1">
							Version{' '}
							<a
								href={downloadUrl}
								target="_blank"
								rel="noreferrer"
								className="font-medium hover:underline"
							>
								{latest}
							</a>{' '}
							is available.
						</p>
						<div className="flex items-center gap-2 sm:gap-3 self-start sm:self-auto">
							{downloading ? (
								<span
									className="inline-flex items-center gap-1.5 text-[13px] text-text-2"
									data-testid="settings-version-downloading"
								>
									<Loader2 className="w-3 h-3 animate-spin" /> Downloading new version…
								</span>
							) : canApply && staged ? (
								<Button
									type="button"
									variant="primary"
									size="sm"
									data-testid="settings-version-install"
									onClick={() => setConfirmOpen(true)}
								>
									Install &amp; restart
								</Button>
							) : canApply && errored ? (
								<>
									<Button
										type="button"
										variant="primary"
										size="sm"
										data-testid="settings-version-retry"
										disabled={download.isPending}
										onClick={() => download.mutate()}
									>
										{download.isPending ? 'Downloading…' : 'Retry download'}
									</Button>
									<a
										href={downloadUrl}
										target="_blank"
										rel="noreferrer"
										data-testid="settings-version-download"
										className="text-[13px] underline underline-offset-2 hover:no-underline"
									>
										Download manually
									</a>
								</>
							) : (
								<a
									href={downloadUrl}
									target="_blank"
									rel="noreferrer"
									data-testid="settings-version-download"
									className="inline-flex items-center justify-center whitespace-nowrap border border-transparent font-medium transition-colors h-[26px] px-2.5 text-[12.5px] rounded-sm bg-inverse text-inverse-fg hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring outline-none"
								>
									Download
								</a>
							)}
						</div>
					</div>
				) : (
					<p
						className="text-[13px] mt-2.5"
						data-testid="settings-version-result"
						aria-live="polite"
					>
						<span className="text-text-2">You're on the latest version.</span>
					</p>
				)}
			</div>
			<p className="text-[13px] text-text-2 mt-3">
				Got feedback?{' '}
				<a
					href="https://x.com/hezo_ai"
					target="_blank"
					rel="noreferrer"
					className="hover:underline hover:text-text-1 transition-colors"
				>
					@hezo_ai
				</a>
			</p>

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
		</section>
	);
}
