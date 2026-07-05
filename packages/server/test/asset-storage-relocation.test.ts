import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalAssetStore, relocateLegacyAssetBlobs } from '../src/assets/drivers/local';

/**
 * Data preservation across the layout change: versions before the asset-store
 * abstraction wrote blobs inside the project workspace tree
 * (`teams/<teamId>/projects/<projectId>/assets/<assetId>`). Opening the local
 * driver must carry every one of them into `<dataDir>/assets/<projectId>/…`
 * so existing instances upgrade with all assets intact.
 */

describe('legacy asset blob relocation', () => {
	let dataDir: string;
	const teamA = 'team-aaaa';
	const p1 = 'project-1111';
	const p2 = 'project-2222';

	const legacyAssetsDir = (teamId: string, projectId: string) =>
		join(dataDir, 'teams', teamId, 'projects', projectId, 'assets');

	beforeAll(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'hezo-asset-relocation-'));
		// Two projects under one team with legacy blobs (one project also has
		// sibling workspace dirs that must survive untouched).
		mkdirSync(legacyAssetsDir(teamA, p1), { recursive: true });
		mkdirSync(join(dataDir, 'teams', teamA, 'projects', p1, 'workspace'), { recursive: true });
		writeFileSync(join(legacyAssetsDir(teamA, p1), 'asset-1'), 'legacy one');
		writeFileSync(join(legacyAssetsDir(teamA, p1), 'asset-2'), 'legacy two');
		mkdirSync(legacyAssetsDir(teamA, p2), { recursive: true });
		writeFileSync(join(legacyAssetsDir(teamA, p2), 'asset-3'), 'legacy three');
		// An empty legacy assets dir — must simply be cleaned up.
		mkdirSync(legacyAssetsDir('team-bbbb', 'project-3333'), { recursive: true });
		// A blob already in the new layout for p1 — must merge, not clobber.
		mkdirSync(join(dataDir, 'assets', p1), { recursive: true });
		writeFileSync(join(dataDir, 'assets', p1, 'asset-new'), 'already migrated');
	});

	afterAll(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	it('moves every legacy blob into <dataDir>/assets/<projectId> and preserves bytes', async () => {
		const store = new LocalAssetStore(dataDir);

		expect((await store.read(p1, 'asset-1')).toString('utf-8')).toBe('legacy one');
		expect((await store.read(p1, 'asset-2')).toString('utf-8')).toBe('legacy two');
		expect((await store.read(p2, 'asset-3')).toString('utf-8')).toBe('legacy three');
		// Pre-existing new-layout blobs merge with the relocated ones.
		expect((await store.read(p1, 'asset-new')).toString('utf-8')).toBe('already migrated');

		expect(readFileSync(join(dataDir, 'assets', p1, 'asset-1'), 'utf-8')).toBe('legacy one');
		// The emptied legacy assets dirs are gone; sibling project dirs survive.
		expect(existsSync(legacyAssetsDir(teamA, p1))).toBe(false);
		expect(existsSync(legacyAssetsDir(teamA, p2))).toBe(false);
		expect(existsSync(legacyAssetsDir('team-bbbb', 'project-3333'))).toBe(false);
		expect(existsSync(join(dataDir, 'teams', teamA, 'projects', p1, 'workspace'))).toBe(true);
	});

	it('is idempotent — a second open moves nothing and loses nothing', async () => {
		relocateLegacyAssetBlobs(dataDir);
		const store = new LocalAssetStore(dataDir);
		expect((await store.read(p1, 'asset-1')).toString('utf-8')).toBe('legacy one');
		expect((await store.read(p1, 'asset-new')).toString('utf-8')).toBe('already migrated');
	});

	it('no-ops on a fresh data dir and an empty dataDir string', () => {
		const fresh = mkdtempSync(join(tmpdir(), 'hezo-asset-fresh-'));
		relocateLegacyAssetBlobs(fresh);
		expect(existsSync(join(fresh, 'assets'))).toBe(false);
		rmSync(fresh, { recursive: true, force: true });
		relocateLegacyAssetBlobs('');
	});
});
