// Git work on a clone serializes per clone store: the project when a backend
// shares one workspace across a project's containers, the container when each
// has its own disk. A lock per project on the second kind only made fresh
// containers clone one after another.

import { SandboxBackend } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { type RepoStore, repoStoreKey, withRepoStoreLock } from '../src/lib/git-lock';
import { setStoredSandboxBackend } from '../src/services/sandbox/backend-store';
import { repoStoreFor } from '../src/services/sandbox/repo-store';
import { safeClose } from './helpers';
import { createTestDbWithMigrations } from './helpers/db';

/** Run two holders and report whether the second entered before the first left. */
async function overlapped(a: RepoStore, b: RepoStore): Promise<boolean> {
	let firstInside = false;
	let overlap = false;
	let releaseFirst!: () => void;
	const firstHeld = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let entered!: () => void;
	const firstEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const first = withRepoStoreLock(a, async () => {
		firstInside = true;
		entered();
		await firstHeld;
		firstInside = false;
	});
	await firstEntered;
	const second = withRepoStoreLock(b, async () => {
		overlap = firstInside;
	});
	// Give the second holder its chance to enter while the first still holds.
	await new Promise((resolve) => setTimeout(resolve, 20));
	releaseFirst();
	await Promise.all([first, second]);
	return overlap;
}

describe('withRepoStoreLock', () => {
	it('lets two containers with their own disks work in parallel', async () => {
		const a = { projectId: 'p1', containerId: 'c1', sharedAcrossContainers: false };
		const b = { projectId: 'p1', containerId: 'c2', sharedAcrossContainers: false };
		expect(repoStoreKey(a)).not.toBe(repoStoreKey(b));
		expect(await overlapped(a, b)).toBe(true);
	});

	it('serializes two containers that share the project workspace', async () => {
		const a = { projectId: 'p2', containerId: 'c1', sharedAcrossContainers: true };
		const b = { projectId: 'p2', containerId: 'c2', sharedAcrossContainers: true };
		expect(repoStoreKey(a)).toBe(repoStoreKey(b));
		expect(await overlapped(a, b)).toBe(false);
	});
});

describe('repoStoreFor', () => {
	let db: Db;

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('reads the store from the backend kind', async () => {
		await setStoredSandboxBackend(db, SandboxBackend.Docker);
		expect((await repoStoreFor(db, 'p3', 'c1')).sharedAcrossContainers).toBe(true);

		await setStoredSandboxBackend(db, SandboxBackend.Daytona);
		expect((await repoStoreFor(db, 'p3', 'c1')).sharedAcrossContainers).toBe(false);
	});
});
