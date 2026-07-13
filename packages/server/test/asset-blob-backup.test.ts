import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUNDLE_ASSETS_DIR, dumpAssetBlobs, restoreAssetBlobs } from '../src/assets/blob-backup';
import { LocalAssetStore } from '../src/assets/drivers/local';
import { openAssetStorage } from '../src/assets/open';
import type { Db } from '../src/db/database';
import { runMigrations } from '../src/db/migrate';
import { openDatabase } from '../src/db/open';
import { BASE_SCHEMA } from '../src/db/schema';
import { safeClose } from './helpers';
import { allMigrations } from './helpers/migrate';
import { createS3Sim } from './helpers/s3-sim';

// Exercises the asset-blob copy engine (dumpAssetBlobs / restoreAssetBlobs)
// against the real drivers — local filesystem and, via the in-process S3
// simulator, S3-compatible storage — including the cross-backend copy that is
// the whole point of the feature (an instance migrating its assets).

const tempDirs: string[] = [];
const sims: Array<{ destroy: () => Promise<void> }> = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'hezo-blob-backup-'));
	tempDirs.push(dir);
	return dir;
}

afterAll(async () => {
	for (const sim of sims) await sim.destroy();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function openMigratedDb(dataDir: string): Promise<Db> {
	const opened = await openDatabase({ dataDir });
	await opened.db.exec(BASE_SCHEMA);
	await runMigrations(opened.db, allMigrations());
	return opened.db;
}

let seedCounter = 0;

interface SeededAsset {
	projectId: string;
	assetId: string;
	content: Buffer;
	sha256: string;
}

/** Insert a team + project + asset row (each in its own 1:1 team) and return its ids. */
async function seedAssetRow(db: Db, content: Buffer): Promise<SeededAsset> {
	const n = ++seedCounter;
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING id`,
		[`Team ${n}`, `team-${n}`],
	);
	const teamId = team.rows[0].id;
	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, $2, $3, $4) RETURNING id`,
		[teamId, `Project ${n}`, `project-${n}`, `P${n}`],
	);
	const projectId = project.rows[0].id;
	const sha256 = createHash('sha256').update(content).digest('hex');
	const asset = await db.query<{ id: string }>(
		`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
		 VALUES ($1, $2, 'text/plain', $3, $4, $5) RETURNING id`,
		[teamId, projectId, content.byteLength, sha256, `file-${n}.txt`],
	);
	return { projectId, assetId: asset.rows[0].id, content, sha256 };
}

describe('asset blob backup/restore', () => {
	it('round-trips blobs through a bundle and verifies sha256', async () => {
		const srcDir = makeTempDir();
		const db = await openMigratedDb(srcDir);
		const store = new LocalAssetStore(srcDir);
		const asset = await seedAssetRow(db, Buffer.from('hello asset bytes'));
		await store.write(asset.projectId, asset.assetId, new Blob([asset.content]));

		const bundleDir = makeTempDir();
		const dump = await dumpAssetBlobs(db, store, bundleDir);
		expect(dump.count).toBe(1);
		expect(dump.bytes).toBe(asset.content.byteLength);
		expect(dump.missing).toEqual([]);
		const bundled = await readFile(
			join(bundleDir, BUNDLE_ASSETS_DIR, asset.projectId, asset.assetId),
		);
		expect(bundled.equals(asset.content)).toBe(true);

		const targetStore = new LocalAssetStore(makeTempDir());
		const restore = await restoreAssetBlobs(db, targetStore, bundleDir);
		expect(restore).toMatchObject({ count: 1, verified: 1, unverified: 0 });
		expect((await targetStore.read(asset.projectId, asset.assetId)).equals(asset.content)).toBe(
			true,
		);

		await safeClose(db as { close: () => Promise<void> });
	});

	it('copies blobs from local storage into an S3-compatible bucket', async () => {
		const srcDir = makeTempDir();
		const db = await openMigratedDb(srcDir);
		const store = new LocalAssetStore(srcDir);
		const asset = await seedAssetRow(db, Buffer.from('to the cloud'));
		await store.write(asset.projectId, asset.assetId, new Blob([asset.content]));

		const bundleDir = makeTempDir();
		await dumpAssetBlobs(db, store, bundleDir);

		const sim = await createS3Sim();
		sims.push(sim);
		const target = await openAssetStorage({
			dataDir: makeTempDir(),
			assetStorageUrl: sim.storeUrl(),
		});
		try {
			const restore = await restoreAssetBlobs(db, target.store, bundleDir);
			expect(restore).toMatchObject({ count: 1, verified: 1 });
			// The `<projectId>/<assetId>` key layout lands in the bucket unchanged.
			const key = `${asset.projectId}/${asset.assetId}`;
			expect(sim.objects.get(key)?.body.equals(asset.content)).toBe(true);
		} finally {
			await target.store.close();
		}
		await safeClose(db as { close: () => Promise<void> });
	});

	it('records a row whose blob is missing at the source and keeps going', async () => {
		const srcDir = makeTempDir();
		const db = await openMigratedDb(srcDir);
		const store = new LocalAssetStore(srcDir);
		const present = await seedAssetRow(db, Buffer.from('present'));
		await store.write(present.projectId, present.assetId, new Blob([present.content]));
		const dangling = await seedAssetRow(db, Buffer.from('row without a blob'));

		const bundleDir = makeTempDir();
		const dump = await dumpAssetBlobs(db, store, bundleDir);
		expect(dump.count).toBe(1);
		expect(dump.missing).toEqual([`${dangling.projectId}/${dangling.assetId}`]);

		await safeClose(db as { close: () => Promise<void> });
	});

	it('fails restore when a bundle blob does not match its database row', async () => {
		const srcDir = makeTempDir();
		const db = await openMigratedDb(srcDir);
		const store = new LocalAssetStore(srcDir);
		const asset = await seedAssetRow(db, Buffer.from('original bytes'));
		await store.write(asset.projectId, asset.assetId, new Blob([asset.content]));

		const bundleDir = makeTempDir();
		await dumpAssetBlobs(db, store, bundleDir);
		// Tamper with the bundled blob so its sha256 no longer matches the row.
		await writeFile(
			join(bundleDir, BUNDLE_ASSETS_DIR, asset.projectId, asset.assetId),
			Buffer.from('tampered bytes'),
		);

		const targetStore = new LocalAssetStore(makeTempDir());
		await expect(restoreAssetBlobs(db, targetStore, bundleDir)).rejects.toThrow(/integrity check/);

		await safeClose(db as { close: () => Promise<void> });
	});

	it('restores blobs with no matching row unverified, or fails under strict', async () => {
		const srcDir = makeTempDir();
		const db = await openMigratedDb(srcDir);
		const store = new LocalAssetStore(srcDir);
		const asset = await seedAssetRow(db, Buffer.from('assets-only blob'));
		await store.write(asset.projectId, asset.assetId, new Blob([asset.content]));

		const bundleDir = makeTempDir();
		await dumpAssetBlobs(db, store, bundleDir);

		// A target database with no matching asset row (e.g. an assets-only restore).
		const emptyDb = await openMigratedDb(makeTempDir());
		const lenient = await restoreAssetBlobs(emptyDb, new LocalAssetStore(makeTempDir()), bundleDir);
		expect(lenient).toMatchObject({ count: 1, verified: 0, unverified: 1 });

		await expect(
			restoreAssetBlobs(emptyDb, new LocalAssetStore(makeTempDir()), bundleDir, { strict: true }),
		).rejects.toThrow(/strict/i);

		await safeClose(db as { close: () => Promise<void> });
		await safeClose(emptyDb as { close: () => Promise<void> });
	});
});
