import type { StartupResult } from './startup';

/**
 * Holds the live server runtime so request handlers (e.g. the update-apply
 * route) and signal handlers can trigger a graceful shutdown without importing
 * the entry module `index.ts` (which has top-level side effects). Set once the
 * startup IIFE completes.
 */
let active: StartupResult | null = null;
let shuttingDown = false;

export function setActiveRuntime(result: StartupResult): void {
	active = result;
}

export function getActiveRuntime(): StartupResult | null {
	return active;
}

/**
 * Graceful shutdown: stop scheduled jobs and CEO sessions, release the egress
 * proxy + ssh agent, and close the database. Idempotent — safe to call from both
 * a termination-signal handler and the update-apply path.
 */
export async function shutdownRuntime(result: StartupResult): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	result.jobManager.shutdown();
	await result.ceoSessionManager.stop();
	await result.egressProxy.releaseAll();
	await result.sshAgentServer.releaseAll();
	await result.assetStore.close();
	await result.db.close();
}
