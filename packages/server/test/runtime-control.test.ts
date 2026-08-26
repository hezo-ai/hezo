import { describe, expect, it, vi } from 'vitest';
import { getActiveRuntime, setActiveRuntime, shutdownRuntime } from '../src/runtime-control';
import type { StartupResult } from '../src/startup';

function fakeRuntime() {
	const jobManager = {
		shutdown: vi.fn(),
		killLiveRunProcesses: vi.fn(async () => {}),
		stopAcceptingWork: vi.fn(),
		drainRunningRuns: vi.fn(async () => []),
	};
	const chatSessionManager = { stop: vi.fn(async () => {}) };
	const egressProxy = { releaseAll: vi.fn(async () => {}) };
	const sshAgentServer = { releaseAll: vi.fn(async () => {}) };
	const assetStore = { close: vi.fn(async () => {}) };
	const db = { close: vi.fn(async () => {}) };
	const policyWatcher = { close: vi.fn() };
	const result = {
		jobManager,
		chatSessionManager,
		egressProxy,
		sshAgentServer,
		assetStore,
		db,
		policyWatcher,
	} as unknown as StartupResult;
	return {
		result,
		jobManager,
		chatSessionManager,
		egressProxy,
		sshAgentServer,
		assetStore,
		db,
		policyWatcher,
	};
}

describe('active runtime accessors', () => {
	it('stores and returns the active runtime', () => {
		const { result } = fakeRuntime();
		expect(getActiveRuntime()).toBeNull();
		setActiveRuntime(result);
		expect(getActiveRuntime()).toBe(result);
	});
});

describe('shutdownRuntime', () => {
	it('stops every subsystem and closes the db on the first call, then is idempotent', async () => {
		const {
			result,
			jobManager,
			chatSessionManager,
			egressProxy,
			sshAgentServer,
			assetStore,
			db,
			policyWatcher,
		} = fakeRuntime();

		await shutdownRuntime(result);
		// Live-run trees are reaped BEFORE the aborts, so the kill can't race exit.
		expect(jobManager.killLiveRunProcesses).toHaveBeenCalledTimes(1);
		expect(jobManager.killLiveRunProcesses.mock.invocationCallOrder[0]).toBeLessThan(
			jobManager.shutdown.mock.invocationCallOrder[0],
		);
		// The whole order is load-bearing: stop scheduling first or the 5s wakeup
		// cron keeps feeding the drain; reap the in-container trees next so the
		// aborts land in milliseconds; drain before `shutdown()` clears the
		// registries, or the aborts have nowhere to land and the db closes while
		// cancelled runs are still writing their terminal rows.
		expect(jobManager.stopAcceptingWork).toHaveBeenCalledTimes(1);
		expect(jobManager.drainRunningRuns).toHaveBeenCalledTimes(1);
		const order = [
			jobManager.stopAcceptingWork.mock.invocationCallOrder[0],
			jobManager.killLiveRunProcesses.mock.invocationCallOrder[0],
			jobManager.drainRunningRuns.mock.invocationCallOrder[0],
			jobManager.shutdown.mock.invocationCallOrder[0],
		];
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(jobManager.shutdown).toHaveBeenCalledTimes(1);
		expect(chatSessionManager.stop).toHaveBeenCalledTimes(1);
		expect(egressProxy.releaseAll).toHaveBeenCalledTimes(1);
		expect(sshAgentServer.releaseAll).toHaveBeenCalledTimes(1);
		// A file watch left armed keeps the process alive past shutdown.
		expect(policyWatcher.close).toHaveBeenCalledTimes(1);
		expect(assetStore.close).toHaveBeenCalledTimes(1);
		expect(db.close).toHaveBeenCalledTimes(1);

		// Second call short-circuits via the shuttingDown guard — no extra teardown.
		await shutdownRuntime(result);
		expect(jobManager.shutdown).toHaveBeenCalledTimes(1);
		expect(db.close).toHaveBeenCalledTimes(1);
	});
});
