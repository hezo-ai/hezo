import { Loader2 } from 'lucide-react';
import { useCheckForUpdate, useUpdateCheck } from '../hooks/use-update-check';
import { Button } from './ui/button';

/** Release tags are plain `MAJOR.MINOR.PATCH` (no `v` prefix) — only those have a GitHub tag page. */
const RELEASE_TAG = /^\d+\.\d+\.\d+$/;

const RELEASES_URL = 'https://github.com/hezo-ai/hezo/releases';

/**
 * Version section at the bottom of the General settings page: the running version
 * (linked to its GitHub release page) plus a "Check for new version" button that
 * forces the same GitHub update check the daily cron runs.
 */
export function VersionDisplay() {
	const { data: update } = useUpdateCheck();
	const check = useCheckForUpdate();

	if (!update?.current) return null;

	const current = update.current;
	const isReleaseTag = RELEASE_TAG.test(current);
	const releaseUrl = isReleaseTag ? `${RELEASES_URL}/tag/${current}` : RELEASES_URL;

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
				{!check.isPending && check.isSuccess && (
					<p
						className="text-[13px] mt-2.5"
						data-testid="settings-version-result"
						aria-live="polite"
					>
						{update.updateAvailable && update.latest ? (
							<span className="text-text-1">
								Version{' '}
								<a
									href={update.url ?? RELEASES_URL}
									target="_blank"
									rel="noreferrer"
									className="font-medium hover:underline"
								>
									{update.latest}
								</a>{' '}
								is available.
							</span>
						) : (
							<span className="text-text-2">You're on the latest version.</span>
						)}
					</p>
				)}
				{check.isError && (
					<p className="text-[13px] text-danger mt-2.5" data-testid="settings-version-error">
						Couldn't check for updates. Please try again.
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
		</section>
	);
}
