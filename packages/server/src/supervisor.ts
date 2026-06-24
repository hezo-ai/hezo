import { UPDATE_RESTART_EXIT_CODE } from '@hezo/shared';
import { logger } from './logger';
import { applyStagedUpdate, sweepStaleBinaries, UpdateApplyError } from './services/updater';

const log = logger.child('supervisor');

/**
 * Run as a thin supervisor over the real server. Spawns the worker (this same
 * binary with `HEZO_WORKER=1`), forwards termination signals to it, and on the
 * worker's restart-sentinel exit applies the staged update and relaunches. Any
 * other exit code is propagated unchanged, so external restart policies
 * (systemd/launchd/Docker) behave exactly as before the supervisor existed.
 *
 * Never returns — it loops until the worker exits non-sentinel, then exits the
 * process with the worker's code.
 */
export async function runSupervisor(dataDir: string): Promise<never> {
	// Clean up any binary left renamed-aside by a previous Windows swap.
	await sweepStaleBinaries();
	log.info('Supervisor starting; launching worker');

	for (;;) {
		// Re-exec this binary with the same user args (argv[0]=runtime, argv[1]=entry).
		const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], {
			env: { ...process.env, HEZO_WORKER: '1' },
			stdin: 'inherit',
			stdout: 'inherit',
			stderr: 'inherit',
		});

		const forward = (sig: NodeJS.Signals) => () => {
			try {
				child.kill(sig);
			} catch {
				// child already exited
			}
		};
		const onTerm = forward('SIGTERM');
		const onInt = forward('SIGINT');
		process.on('SIGTERM', onTerm);
		process.on('SIGINT', onInt);

		const code = await child.exited;

		process.off('SIGTERM', onTerm);
		process.off('SIGINT', onInt);

		if (code === UPDATE_RESTART_EXIT_CODE) {
			log.info('Worker requested update restart; applying staged update');
			try {
				await applyStagedUpdate(dataDir);
				log.info('Update applied; relaunching worker on the new binary');
			} catch (err) {
				const msg = err instanceof UpdateApplyError ? err.message : String(err);
				log.error(`Update apply failed; relaunching the previous version: ${msg}`);
			}
			continue; // relaunch — new binary on success, previous binary on failure
		}

		log.info(`Worker exited with code ${code}; supervisor exiting`);
		process.exit(code ?? 0);
	}
}
