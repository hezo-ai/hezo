/**
 * Last-boot failure breadcrumb.
 *
 * The operator-actionable startup failures (a failed migration, a data dir from
 * a newer binary, unreachable external Postgres, broken asset storage) print to
 * the log and `process.exit(1)`. Under a restart policy - `Restart=always` in the
 * systemd unit `deploy/provision.sh` installs - the process comes straight back,
 * fails the same way, and exits again. From a browser that presents as the boot
 * screen alternating with a gateway error forever, with the real reason visible
 * only to someone who can read the service log. Hezo is self-hosted, so that is
 * frequently a person on a phone who cannot.
 *
 * So the reason is written to the data dir on the way out and read back by the
 * NEXT boot, which serves it on `/api/status` for the loading screen to show. It
 * is cleared once a boot reaches `ready`, so it only ever describes the failure
 * the user is currently stuck in.
 *
 * Best-effort by construction: a crash the process cannot observe (an OOM kill,
 * SIGKILL) leaves no breadcrumb. The loading screen's own restart counter covers
 * that case - see `packages/web/src/components/starting-screen.tsx`.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger';
import type { StartupPhaseId } from './startup-progress';

const log = logger.child('startup-failure');

const FILE = '.last-startup-error.json';

export interface StartupFailureRecord {
	/** Operator-facing reason. Safe to show in the browser - never a secret. */
	message: string;
	/** The boot phase that was in flight when it failed. */
	phase: StartupPhaseId;
	/** Hezo version that failed, so an upgrade-induced failure is obvious. */
	version: string;
	/** ISO timestamp of the failure. */
	at: string;
}

function pathFor(dataDir: string): string {
	return join(dataDir, FILE);
}

/**
 * Record a fatal startup failure. Synchronous on purpose - the caller exits the
 * process on the next line, so there is no event loop left to flush an async
 * write. Never throws: a breadcrumb that cannot be written must not mask the
 * failure it describes.
 */
export function recordStartupFailure(
	dataDir: string,
	failure: Omit<StartupFailureRecord, 'at'>,
): void {
	try {
		const record: StartupFailureRecord = { ...failure, at: new Date().toISOString() };
		writeFileSync(pathFor(dataDir), JSON.stringify(record), 'utf-8');
	} catch (err) {
		log.warn(`Could not record the startup failure: ${err instanceof Error ? err.message : err}`);
	}
}

/** The previous boot's failure, or `null` when the last boot was clean. */
export function readStartupFailure(dataDir: string): StartupFailureRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(pathFor(dataDir), 'utf-8')) as Partial<
			Record<keyof StartupFailureRecord, unknown>
		>;
		// A truncated or hand-edited file must not break the boot screen.
		if (typeof parsed.message !== 'string' || parsed.message.length === 0) return null;
		return {
			message: parsed.message,
			phase: (typeof parsed.phase === 'string' ? parsed.phase : 'error') as StartupPhaseId,
			version: typeof parsed.version === 'string' ? parsed.version : 'unknown',
			at: typeof parsed.at === 'string' ? parsed.at : '',
		};
	} catch {
		return null;
	}
}

/** Drop the breadcrumb once a boot succeeds. Never throws. */
export function clearStartupFailure(dataDir: string): void {
	try {
		rmSync(pathFor(dataDir), { force: true });
	} catch {
		// A stale breadcrumb is cosmetic; never fail a good boot over it.
	}
}
