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

	return (
		<div
			data-testid="update-restart-overlay"
			className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-[var(--overlay)] backdrop-blur-sm p-6 text-center"
		>
			<Loader2 className="w-8 h-8 animate-spin text-text-1" />
			<div className="text-base font-semibold text-text-1">
				{reachableAgain ? 'Reloading…' : 'Updating Hezo…'}
			</div>
			<p className="max-w-sm text-[13px] text-text-2 leading-relaxed">
				{targetVersion ? `Restarting onto ${targetVersion}. ` : 'Restarting. '}
				In-flight agent runs are paused and resume automatically. When Hezo comes back you'll need
				your 12-word master key to unlock it again.
			</p>
		</div>
	);
}
