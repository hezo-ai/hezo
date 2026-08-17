import { UPDATE_RESTART_EXIT_CODE } from '@hezo/shared';
import { logger } from './logger';
import type { StartupResult } from './startup';

const log = logger.child('runtime');

/**
 * Holds the live server runtime so request handlers (e.g. the update-apply
 * route) and signal handlers can trigger a graceful shutdown without importing
 * the entry module `index.ts` (which has top-level side effects). Set once the
 * startup IIFE completes.
 */
let active: StartupResult | null = null;
let shuttingDown = false;

/**
 * How long shutdown waits for in-flight runs to write a terminal row.
 *
 * Sized against the documented systemd `TimeoutStopSec=30`: the in-container
 * reap above it is bounded at 8s, and the closes below it need room too, so this
 * plus both must fit inside that budget or the supervisor SIGKILLs mid-write.
 * Lowering one without the other is what breaks it.
 */
const RUN_DRAIN_DEADLINE_MS = 10_000;

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
	// Reap live runs' in-container process trees BEFORE aborting them: the abort
	// path's own kill is fire-and-forget and would race process.exit, stranding
	// the agent CLIs in the warm containers until the next boot sweep. Bounded
	// internally so a dead Docker socket can't wedge shutdown.
	// Stop scheduling first, or the 5s wakeup cron keeps handing fresh runs to a
	// process on its way out and the drain below never converges.
	result.jobManager.stopAcceptingWork();
	await result.jobManager
		.killLiveRunProcesses()
		.catch((err) => log.warn('live-run process reap during shutdown failed', err));
	// Then give the aborts somewhere to land. Without this the registries were
	// cleared synchronously and the DB closed while the runs just cancelled were
	// still writing their terminal rows, so a clean restart looked to the next
	// boot exactly like a crash.
	const stranded = await result.jobManager.drainRunningRuns(RUN_DRAIN_DEADLINE_MS).catch((err) => {
		log.warn('run drain during shutdown failed', err);
		return [];
	});
	if (stranded.length > 0) {
		log.warn(
			`Shutdown: ${stranded.length} run(s) still in flight after ${RUN_DRAIN_DEADLINE_MS}ms; ` +
				`startup reconciliation will fail and re-queue them: ` +
				stranded.map((r) => `${r.runId}${r.taskId ? ` (task ${r.taskId})` : ''}`).join(', '),
		);
	}
	result.jobManager.shutdown();
	await result.chatSessionManager.stop();
	await result.egressProxy.releaseAll();
	await result.sshAgentServer.releaseAll();
	await result.assetStore.close();
	await result.db.close();
}

/**
 * Gracefully shut down the live runtime and exit with the restart sentinel so
 * the supervisor applies the staged binary and relaunches. Shared by the
 * superuser "Install & restart" route and the auto-install cron; callers have
 * already verified a staged update exists. Never returns.
 */
export async function exitToApplyUpdate(): Promise<never> {
	const runtime = getActiveRuntime();
	try {
		if (runtime) await shutdownRuntime(runtime);
	} catch (err) {
		log.error('shutdown before update-apply failed', err);
	}
	log.info('Exiting with restart sentinel to apply staged update');
	process.exit(UPDATE_RESTART_EXIT_CODE);
}
