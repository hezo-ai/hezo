/**
 * Startup progress shared between the long-running `startup()` sequence and the
 * pre-ready request handler (`startup-serving.ts`, wired into the Bun fetch entry
 * in `index.ts`).
 *
 * While the server boots it can't serve the real app yet, so the entry handler
 * serves the SPA shell and answers `/api/status` from this singleton. The web UI
 * renders a loading screen that names the current phase instead of the browser
 * showing a raw JSON 503. Messages here are user-facing — keep them generic and
 * free of secrets/paths.
 */

export type StartupPhaseId =
	| 'starting'
	| 'database'
	| 'migrations'
	| 'seed'
	| 'asset-storage'
	| 'pricing'
	| 'workspace'
	| 'ready'
	| 'error';

export interface StartupProgress {
	phase: StartupPhaseId;
	/** Human-readable, safe to show in the browser. */
	message: string;
	/** Optional extra context for the loading screen (never secrets). */
	detail?: string;
}

const PHASE_MESSAGES: Record<StartupPhaseId, string> = {
	starting: 'Starting up…',
	database: 'Opening the database…',
	migrations: 'Running database migrations…',
	seed: 'Preparing data…',
	'asset-storage': 'Connecting to asset storage…',
	pricing: 'Loading model pricing…',
	workspace: 'Setting up your workspace…',
	ready: 'Ready',
	error: 'Startup failed',
};

let current: StartupProgress = { phase: 'starting', message: PHASE_MESSAGES.starting };

export function getStartupProgress(): StartupProgress {
	return current;
}

export function setStartupPhase(phase: StartupPhaseId, detail?: string): void {
	current = { phase, message: PHASE_MESSAGES[phase], detail };
}

/** Record a fatal startup failure so the loading screen can surface it. */
export function markStartupError(detail: string): void {
	current = { phase: 'error', message: PHASE_MESSAGES.error, detail };
}
