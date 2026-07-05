import { describe, expect, it, vi } from 'vitest';
import { getActiveRuntime, setActiveRuntime, shutdownRuntime } from '../src/runtime-control';
import type { StartupResult } from '../src/startup';

function fakeRuntime() {
	const jobManager = { shutdown: vi.fn() };
	const ceoSessionManager = { stop: vi.fn(async () => {}) };
	const egressProxy = { releaseAll: vi.fn(async () => {}) };
	const sshAgentServer = { releaseAll: vi.fn(async () => {}) };
	const assetStore = { close: vi.fn(async () => {}) };
	const db = { close: vi.fn(async () => {}) };
	const result = {
		jobManager,
		ceoSessionManager,
		egressProxy,
		sshAgentServer,
		assetStore,
		db,
	} as unknown as StartupResult;
	return { result, jobManager, ceoSessionManager, egressProxy, sshAgentServer, assetStore, db };
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
		const { result, jobManager, ceoSessionManager, egressProxy, sshAgentServer, assetStore, db } =
			fakeRuntime();

		await shutdownRuntime(result);
		expect(jobManager.shutdown).toHaveBeenCalledTimes(1);
		expect(ceoSessionManager.stop).toHaveBeenCalledTimes(1);
		expect(egressProxy.releaseAll).toHaveBeenCalledTimes(1);
		expect(sshAgentServer.releaseAll).toHaveBeenCalledTimes(1);
		expect(assetStore.close).toHaveBeenCalledTimes(1);
		expect(db.close).toHaveBeenCalledTimes(1);

		// Second call short-circuits via the shuttingDown guard — no extra teardown.
		await shutdownRuntime(result);
		expect(jobManager.shutdown).toHaveBeenCalledTimes(1);
		expect(db.close).toHaveBeenCalledTimes(1);
	});
});
