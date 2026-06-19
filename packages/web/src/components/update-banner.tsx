import { X } from 'lucide-react';
import { useState } from 'react';
import { useUpdateCheck } from '../hooks/use-update-check';

const DISMISS_KEY = 'hezo:update-dismissed';

function readDismissed(): string | null {
	try {
		return localStorage.getItem(DISMISS_KEY);
	} catch {
		return null;
	}
}

/**
 * Dismissible "update available" banner. A newer release is detected by the
 * server (`/api/updates/latest`); clicking through opens the GitHub Release to
 * download. Dismissal is remembered per-version so it won't nag for the same one.
 */
export function UpdateBanner() {
	const { data } = useUpdateCheck();
	const [dismissed, setDismissed] = useState<string | null>(readDismissed);

	if (!data?.updateAvailable || !data.latest || dismissed === data.latest) return null;

	const dismiss = () => {
		try {
			localStorage.setItem(DISMISS_KEY, data.latest as string);
		} catch {
			// ignore storage failures — banner just reappears next load
		}
		setDismissed(data.latest);
	};

	return (
		<div
			data-testid="update-banner"
			className="flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-2 text-[13px] bg-surface border-b border-border text-text-1"
		>
			<span className="flex-1">
				Hezo <span className="font-medium">{data.latest}</span> is available — you're on{' '}
				{data.current}.
			</span>
			<div className="flex items-center gap-3">
				{data.url && (
					<a
						href={data.url}
						target="_blank"
						rel="noreferrer"
						className="font-medium text-text-1 hover:underline"
					>
						Download
					</a>
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
		</div>
	);
}
