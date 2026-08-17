import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Poll cadence (ms) while waiting for the relaunched worker to answer. */
const POLL_INTERVAL_MS = 1500;
/**
 * Last-resort reload after this long, so a missed transition can never strand the
 * overlay indefinitely. A slightly-early reload is safe — the app shell lands on
 * the boot `StartingScreen` and polls `/api/status` until the new worker is ready.
 */
const FALLBACK_RELOAD_MS = 120_000;

/**
 * Decide, from one `/api/status` sample, whether the relaunched worker is up and
 * we should reload. Pure so it can be unit-tested without DOM/fetch.
 *
 * The primary signal is a **version change**: `/api/status.version` is the running
 * binary's `HEZO_VERSION`, so once it differs from the version we're restarting
 * away from (`fromVersion`, also `HEZO_VERSION`), the new binary is up — this holds
 * even if we never caught the brief unreachable window (polls are seconds apart) and
 * even before the new worker is fully ready (its booting `starting: true` response
 * already carries the new version). `wentDown → back-up` is a fallback for a
 * same-version restart (reinstall, or a failed apply where the supervisor relaunches
 * the previous binary) where the version never changes.
 */
export function evaluateRestartPoll(
	state: { fromVersion: string | null; wentDown: boolean },
	sample: { ok: boolean; starting: boolean; version: string | null },
): { reload: boolean; wentDown: boolean } {
	// Non-ok / network error → the worker is down mid-restart.
	if (!sample.ok) return { reload: false, wentDown: true };
	const swapped = !!sample.version && !!state.fromVersion && sample.version !== state.fromVersion;
	// It went away and is back, finished booting, on the same version.
	const backUp = state.wentDown && !sample.starting;
	return { reload: swapped || backUp, wentDown: state.wentDown };
}

/**
 * Full-screen overlay shown while the server restarts onto a new binary. Polls
 * `/api/status` (the same public endpoint the app shell gates on) and reloads the
 * page once the relaunched worker is up. A supervised update restart comes back
 * already unlocked (the supervisor hands the in-memory unlock key to the new
 * worker), so the copy only warns about re-entering the master key when the
 * instance will actually come back locked (`autoUnlock` is false).
 */
export function UpdateRestartOverlay({
	targetVersion,
	fromVersion,
	autoUnlock,
}: {
	targetVersion: string | null;
	fromVersion: string | null;
	autoUnlock: boolean;
}) {
	const [reloading, setReloading] = useState(false);
	const wentDown = useRef(false);

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;

		const reload = () => {
			if (cancelled) return;
			setReloading(true);
			window.location.reload();
		};

		const poll = async () => {
			let sample: { ok: boolean; starting: boolean; version: string | null };
			try {
				const res = await fetch('/api/status', { cache: 'no-store' });
				const body = res.ok
					? ((await res.json().catch(() => null)) as {
							starting?: boolean;
							version?: string;
						} | null)
					: null;
				sample = {
					ok: res.ok,
					starting: body?.starting === true,
					version: body?.version ?? null,
				};
			} catch {
				// Network error → the worker is down mid-restart.
				sample = { ok: false, starting: false, version: null };
			}
			const result = evaluateRestartPoll({ fromVersion, wentDown: wentDown.current }, sample);
			wentDown.current = result.wentDown;
			if (result.reload) {
				reload();
				return;
			}
			if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
		};

		// Poll immediately (a brief restart window can fall between delayed polls),
		// then on the interval, with a timeout fallback that reloads regardless.
		void poll();
		const fallback = setTimeout(reload, FALLBACK_RELOAD_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			clearTimeout(fallback);
		};
	}, [fromVersion]);

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
					{reloading ? 'Reloading…' : 'Updating Hezo…'}
				</div>
				<p className="text-[13px] text-text-2 leading-relaxed">
					{targetVersion ? `Restarting onto ${targetVersion}. ` : 'Restarting. '}
					In-flight agent runs are paused and resume automatically.{' '}
					{autoUnlock
						? 'Hezo will come back unlocked - no master key needed.'
						: "When Hezo comes back you'll need your 12-word master key to unlock it again."}
				</p>
			</div>
		</div>
	);
}
