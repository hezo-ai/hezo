import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { StartupFailure } from '../lib/auth';
import { Logo } from './ui/logo';

/**
 * Boot phases in the order the server advances through them - mirrors
 * `StartupPhaseId` in `packages/server/src/startup-progress.ts`. Only the
 * ordering is used: a phase moving *backwards* means a fresh process answered
 * the poll, i.e. the server restarted mid-boot.
 */
const PHASE_ORDER = [
	'starting',
	'database',
	'migrations',
	'seed',
	'asset-storage',
	'pricing',
	'workspace',
	'ready',
];

/** How long one phase may run before the screen reassures the user it's still working. */
const SLOW_PHASE_SECONDS = 30;

function formatElapsed(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

interface StartingScreenProps {
	/** Coarse phase id; `error` switches to the failure layout. */
	phase?: string;
	/** Human-readable phase message from the server. */
	message?: string;
	/** Optional extra context (e.g. the step in flight, or the failure reason). */
	detail?: string;
	/** Why the previous boot died, when the server left a breadcrumb. */
	lastFailure?: StartupFailure;
}

/**
 * Full-screen loading state shown while the server is still booting. The compiled
 * binary serves the SPA shell during startup, so the web UI renders this instead
 * of the browser showing a raw `STARTING` JSON 503. `useStatus` keeps polling
 * `/api/status` and the app flips to the master-key gate the moment boot finishes.
 *
 * Migrations are the phase that strands people: they run in the server process,
 * and on a large instance copying `pgdata` aside before applying them takes
 * minutes. So this screen carries two signals a bare spinner can't - elapsed time
 * within the phase, and a restart notice when the phase goes backwards (a failed
 * migration exits the process, the supervisor restarts it, and it fails the same
 * way, which otherwise presents as a spinner that never ends).
 */
export function StartingScreen({ phase, message, detail, lastFailure }: StartingScreenProps) {
	const isError = phase === 'error';
	const [elapsed, setElapsed] = useState(0);
	const [restarts, setRestarts] = useState(0);
	const lastPhaseIndex = useRef(-1);

	// biome-ignore lint/correctness/useExhaustiveDependencies: phase is the deliberate trigger — elapsed is per-phase, so the timer restarts when the server advances
	useEffect(() => {
		if (isError) return;
		setElapsed(0);
		const startedAt = Date.now();
		const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
		return () => clearInterval(id);
	}, [isError, phase]);

	useEffect(() => {
		const index = PHASE_ORDER.indexOf(phase ?? 'starting');
		if (index < 0) return;
		if (lastPhaseIndex.current > index) setRestarts((count) => count + 1);
		lastPhaseIndex.current = index;
	}, [phase]);

	return (
		<div
			className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center"
			data-testid="starting-screen"
		>
			<Logo size="lg" />
			{isError ? (
				<div className="flex flex-col items-center gap-2">
					<p className="text-sm font-medium text-danger">{message ?? 'Startup failed'}</p>
					{detail && <p className="max-w-md break-words text-[13px] text-text-2">{detail}</p>}
					<p className="text-[13px] text-text-2">Check the server logs for details.</p>
				</div>
			) : (
				<div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
					<Loader2 className="h-6 w-6 animate-spin text-text-2" aria-hidden />
					<div className="flex flex-col items-center gap-1">
						<p className="text-sm font-medium text-text-1">{message ?? 'Starting up…'}</p>
						{detail && <p className="max-w-md break-words text-[13px] text-text-2">{detail}</p>}
						{elapsed >= SLOW_PHASE_SECONDS && (
							<p className="max-w-md text-[13px] text-text-2">
								Still working ({formatElapsed(elapsed)}). A large database can take several minutes
								to migrate - it is safe to leave this page open.
							</p>
						)}
					</div>
				</div>
			)}
			{/* The previous boot died fatally and the restart policy brought us straight
			    back, so the same failure is about to repeat. Say what it was. */}
			{!isError && lastFailure && (
				<div
					className="flex max-w-md flex-col gap-1 rounded-lg bg-warning-soft px-4 py-3 text-left"
					data-testid="starting-screen-last-failure"
				>
					<p className="text-[13px] font-medium text-warning-soft-fg">
						The previous start failed during "{lastFailure.phase}" on {lastFailure.version}.
					</p>
					<p className="break-words text-[13px] text-warning-soft-fg">{lastFailure.message}</p>
				</div>
			)}
			{!isError && restarts > 0 && (
				<p
					className="max-w-md break-words text-[13px] text-warning-soft-fg"
					data-testid="starting-screen-restarts"
				>
					The server restarted while starting up ({restarts} {restarts === 1 ? 'time' : 'times'}).
					It may be failing to boot - check the server logs.
				</p>
			)}
		</div>
	);
}
