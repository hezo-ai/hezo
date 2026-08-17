// The drain is plain JS timing over the dispatch registries, not `node:`
// behaviour, so it belongs in the vitest tier rather than the Bun-native one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp } from './helpers/app';

let db: Db;
let masterKeyManager: MasterKeyManager;
let dataDir: string;

function makeManager(): JobManager {
	return new JobManager({
		db,
		docker: createStubDocker({ ping: async () => true }),
		masterKeyManager,
		serverPort: 3100,
		dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;
});

afterAll(async () => {
	await safeClose(db);
});

describe('shutdown drain', () => {
	it('refuses new work once it has stopped accepting', () => {
		// Without this the 5s wakeup cron keeps handing fresh runs to a process on
		// its way out, and the drain below never converges.
		const jm = makeManager();
		expect(jm.launchTask('drain-accepting', async () => {}, 1_000)).toBe(true);
		jm.stopAcceptingWork();
		expect(jm.launchTask('drain-refused', async () => {}, 1_000)).toBe(false);
		jm.shutdown();
	});

	it('returns immediately when nothing is in flight', async () => {
		const jm = makeManager();
		expect(await jm.drainRunningRuns(5_000)).toEqual([]);
		jm.shutdown();
	});

	it('waits for a settling run and aborts it with the shutdown reason', async () => {
		// Before the drain existed, `shutdown()` aborted and cleared the registries
		// in one step, so the DB closed while the runs it had just cancelled were
		// still writing their terminal rows.
		const jm = makeManager();
		let seenReason: unknown;
		const launched = jm.launchTask(
			'drain-settling',
			(signal) =>
				new Promise<void>((resolve) => {
					signal.addEventListener('abort', () => {
						seenReason = signal.reason;
						resolve();
					});
				}),
			60_000,
		);
		expect(launched).toBe(true);

		const stranded = await jm.drainRunningRuns(5_000);

		expect(seenReason).toBe('server_shutdown');
		expect(stranded).toEqual([]);
		jm.shutdown();
	});

	it('gives up at the deadline rather than holding shutdown open', async () => {
		// A run that never settles must not outlast the budget the service manager
		// allows, or the supervisor SIGKILLs mid-write.
		const jm = makeManager();
		// Released after the assertion so the test leaves nothing pending behind it -
		// an unsettled promise here would hang the suite's own teardown, not just
		// this case.
		let release: (() => void) | undefined;
		jm.launchTask(
			'drain-wedged',
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
			60_000,
		);
		const started = Date.now();
		await jm.drainRunningRuns(200);
		expect(Date.now() - started).toBeLessThan(5_000);
		jm.shutdown();
		release?.();
	});
});
