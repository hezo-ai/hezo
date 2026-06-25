import { Loader2 } from 'lucide-react';
import { Logo } from './ui/logo';

interface StartingScreenProps {
	/** Coarse phase id; `error` switches to the failure layout. */
	phase?: string;
	/** Human-readable phase message from the server. */
	message?: string;
	/** Optional extra context (e.g. the failure reason). */
	detail?: string;
}

/**
 * Full-screen loading state shown while the server is still booting. The compiled
 * binary serves the SPA shell during startup, so the web UI renders this instead
 * of the browser showing a raw `STARTING` JSON 503. `useStatus` keeps polling
 * `/api/status` and the app flips to the master-key gate the moment boot finishes.
 */
export function StartingScreen({ phase, message, detail }: StartingScreenProps) {
	const isError = phase === 'error';

	return (
		<div
			className="flex min-h-screen flex-col items-center justify-center gap-5 px-6 text-center"
			data-testid="starting-screen"
		>
			<Logo size="lg" wordmark />
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
					</div>
				</div>
			)}
		</div>
	);
}
