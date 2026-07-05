import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Full-screen overlay shown while the server restarts onto a new binary. Polls
 * `/api/status` (the same public endpoint the app shell gates on); once the
 * server has gone down and come back, it reloads the page. A locked return lands
 * on the master-key gate via `AppShell`, which is why the copy reminds the
 * operator they'll need their master key.
 */
export function UpdateRestartOverlay({ targetVersion }: { targetVersion: string | null }) {
	const [reachableAgain, setReachableAgain] = useState(false);
	const wentDown = useRef(false);

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;

		const poll = async () => {
			try {
				const res = await fetch('/api/status', { cache: 'no-store' });
				if (res.ok && wentDown.current) {
					// Server went away and is back — reload onto the new version.
					if (!cancelled) {
						setReachableAgain(true);
						window.location.reload();
					}
					return;
				}
				if (!res.ok) wentDown.current = true;
			} catch {
				// Network error → the worker is down mid-restart.
				wentDown.current = true;
			}
			if (!cancelled) timer = setTimeout(poll, 1500);
		};

		timer = setTimeout(poll, 1500);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, []);

	// The scrim (`--overlay`) is a dark, semi-transparent dim in both themes, so
	// text rendered directly on it washes out in light mode. Mirror every other
	// overlay consumer (dialogs/drawers) and float the copy in a `bg-surface` card
	// so `text-1`/`text-2` keep their intended contrast in both themes.
	return (
		<div
			data-testid="update-restart-overlay"
			className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--overlay)] backdrop-blur-sm p-4 sm:p-6"
		>
			<div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border border-border bg-surface p-6 text-center shadow-lg sm:p-8">
				<Loader2 className="w-8 h-8 animate-spin text-text-1" />
				<div className="text-base font-semibold text-text-1">
					{reachableAgain ? 'Reloading…' : 'Updating Hezo…'}
				</div>
				<p className="text-[13px] text-text-2 leading-relaxed">
					{targetVersion ? `Restarting onto ${targetVersion}. ` : 'Restarting. '}
					In-flight agent runs are paused and resume automatically. When Hezo comes back you'll need
					your 12-word master key to unlock it again.
				</p>
			</div>
		</div>
	);
}
