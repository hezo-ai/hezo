import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BUNDLE_ASSETS_DIR, BUNDLE_DB_NAME, BUNDLE_MANIFEST_NAME } from '../src/assets/blob-backup';
import { LocalAssetStore } from '../src/assets/drivers/local';
import { runBackup, runRestore } from '../src/cli';
import type { Db } from '../src/db/database';
import { instanceLockPath, removeInstanceLock, writeInstanceLock } from '../src/db/instance-lock';
import { peekLogicalBackupHeaderFromFile } from '../src/db/logical-backup';
import { runMigrations } from '../src/db/migrate';
import { openDatabase } from '../src/db/open';
import { BASE_SCHEMA } from '../src/db/schema';
import { safeClose } from './helpers';
import { allMigrations } from './helpers/migrate';
import { createS3Sim, type S3Sim } from './helpers/s3-sim';

// Exercises the `hezo backup` / `hezo restore` subcommands end-to-end against
// real embedded databases on disk — the same open/migrate/dump/restore code the
// CLI runs in production.

const argv = (...tokens: string[]) => ['bun', 'src/index.ts', ...tokens];

const tempDirs: string[] = [];
const sims: S3Sim[] = [];
function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'hezo-cli-brt-'));
	tempDirs.push(dir);
	return dir;
}

/** Boot a fully migrated embedded instance under `dataDir` and seed a marker team. */
async function seedMigratedDataDir(dataDir: string): Promise<void> {
	const opened = await openDatabase({ dataDir });
	try {
		await opened.db.exec(BASE_SCHEMA);
		await runMigrations(opened.db, allMigrations());
		await opened.db.query(`INSERT INTO teams (name, slug) VALUES ('Backup Probe', 'backup-probe')`);
	} finally {
		await safeClose(opened.db as { close: () => Promise<void> });
	}
}

async function teamSlugs(db: Db): Promise<string[]> {
	const r = await db.query<{ slug: string }>('SELECT slug FROM teams ORDER BY slug');
	return r.rows.map((row) => row.slug);
}

interface SeededAsset {
	projectId: string;
	assetId: string;
	content: Buffer;
}

/**
 * Add a project + asset (row + local blob) under the seeded `backup-probe` team.
 * Call after `seedMigratedDataDir`.
 */
async function seedAssetInDataDir(dataDir: string): Promise<SeededAsset> {
	const opened = await openDatabase({ dataDir });
	try {
		const team = await opened.db.query<{ id: string }>(
			`SELECT id FROM teams WHERE slug = 'backup-probe'`,
		);
		const teamId = team.rows[0].id;
		const project = await opened.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Assets', 'assets-probe', 'AP') RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;
		const content = Buffer.from('cli bundle asset payload');
		const sha256 = createHash('sha256').update(content).digest('hex');
		const asset = await opened.db.query<{ id: string }>(
			`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, 'text/plain', $3, $4, 'probe.txt') RETURNING id`,
			[teamId, projectId, content.byteLength, sha256],
		);
		const assetId = asset.rows[0].id;
		await new LocalAssetStore(dataDir).write(projectId, assetId, new Blob([content]));
		return { projectId, assetId, content };
	} finally {
		await safeClose(opened.db as { close: () => Promise<void> });
	}
}

describe('hezo backup / hezo restore subcommands', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let prevDatabaseUrl: string | undefined;
	let prevAssetStorageUrl: string | undefined;
	let prevDataDir: string | undefined;

	beforeAll(() => {
		prevDatabaseUrl = process.env.HEZO_DATABASE_URL;
		prevAssetStorageUrl = process.env.HEZO_ASSET_STORAGE_URL;
		prevDataDir = process.env.HEZO_DATA_DIR;
		delete process.env.HEZO_DATABASE_URL;
		delete process.env.HEZO_ASSET_STORAGE_URL;
		delete process.env.HEZO_DATA_DIR;
	});

	afterAll(async () => {
		if (prevDatabaseUrl === undefined) delete process.env.HEZO_DATABASE_URL;
		else process.env.HEZO_DATABASE_URL = prevDatabaseUrl;
		if (prevAssetStorageUrl === undefined) delete process.env.HEZO_ASSET_STORAGE_URL;
		else process.env.HEZO_ASSET_STORAGE_URL = prevAssetStorageUrl;
		if (prevDataDir === undefined) delete process.env.HEZO_DATA_DIR;
		else process.env.HEZO_DATA_DIR = prevDataDir;
		for (const sim of sims) await sim.destroy();
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.HEZO_DATABASE_URL;
		delete process.env.HEZO_ASSET_STORAGE_URL;
		delete process.env.HEZO_DATA_DIR;
	});

	it('runBackup/runRestore return false when another (or no) subcommand is invoked', async () => {
		expect(await runBackup(argv('--port', '8080'))).toBe(false);
		expect(await runBackup(argv('restore', '/tmp/x'))).toBe(false);
		expect(await runRestore(argv('--port', '8080'))).toBe(false);
		expect(await runRestore(argv('backup'))).toBe(false);
	});

	it('backs up a migrated instance and restores it into a fresh data dir (logical round-trip)', async () => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);

		// --no-assets keeps the DB-only single-file artifact. Explicit --output path.
		const output = join(makeTempDir(), 'probe.backup.gz');
		expect(
			await runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets', '--output', output)),
		).toBe(true);
		expect(existsSync(output)).toBe(true);
		const header = await peekLogicalBackupHeaderFromFile(output);
		expect(header?.formatVersion).toBe(1);
		expect(header?.migrations.length).toBeGreaterThan(0);
		expect(
			logSpy.mock.calls.some((c) => String(c[0]).includes('Wrote logical backup of embedded')),
		).toBe(true);

		// Default output path lands under <data-dir>/backups.
		expect(await runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets'))).toBe(true);
		const defaults = await readdir(join(sourceDir, 'backups'));
		expect(defaults.some((f) => /^hezo-.*\.backup\.gz$/.test(f))).toBe(true);

		// Restore into a fresh (empty) embedded target.
		const targetDir = makeTempDir();
		logSpy.mockClear();
		expect(await runRestore(argv('restore', output, '--data-dir', targetDir))).toBe(true);
		expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Restored logical backup'))).toBe(
			true,
		);

		const restored = await openDatabase({ dataDir: targetDir });
		try {
			expect(await teamSlugs(restored.db)).toContain('backup-probe');
		} finally {
			await safeClose(restored.db as { close: () => Promise<void> });
		}

		// --wipe restores over the now non-empty target.
		expect(await runRestore(argv('restore', output, '--data-dir', targetDir, '--wipe'))).toBe(true);
		const rewiped = await openDatabase({ dataDir: targetDir });
		try {
			expect(await teamSlugs(rewiped.db)).toContain('backup-probe');
		} finally {
			await safeClose(rewiped.db as { close: () => Promise<void> });
		}
	}, 120_000);

	it('refuses a file that is not a logical backup and points at the fix', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as never);

		// Anything whose header doesn't parse — including a legacy pgdata tarball,
		// which is no longer restorable — is rejected rather than guessed at.
		const dir = makeTempDir();
		const fakeTar = join(dir, 'legacy.tar.gz');
		writeFileSync(fakeTar, 'definitely not a logical backup');

		// Embedded target.
		const targetDir = makeTempDir();
		await expect(runRestore(argv('restore', fakeTar, '--data-dir', targetDir))).rejects.toThrow(
			'process.exit(1)',
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
		// The message names the format expected and how to convert an old snapshot.
		const said = (needle: string) => errorSpy.mock.calls.some((c) => String(c[0]).includes(needle));
		expect(said('.backup.gz')).toBe(true);
		expect(said('legacy pgdata snapshot')).toBe(true);
		expect(said('hezo backup')).toBe(true);
		// Nothing was written to the target data dir — a rejected restore is inert.
		expect(existsSync(join(targetDir, 'pgdata'))).toBe(false);

		// External target: same refusal (--database-url flag variant).
		errorSpy.mockClear();
		await expect(
			runRestore(argv('restore', fakeTar, '--database-url', 'postgres://u:p@h:5432/db')),
		).rejects.toThrow('process.exit(1)');
		expect(said('.backup.gz')).toBe(true);

		// Env variant — HEZO_DATABASE_URL wins over the (absent) flag.
		errorSpy.mockClear();
		process.env.HEZO_DATABASE_URL = 'postgres://u:p@h:5432/db';
		await expect(runRestore(argv('restore', fakeTar))).rejects.toThrow('process.exit(1)');
		expect(said('.backup.gz')).toBe(true);
	});

	it('backs up a bundle (database + assets) and restores both into a fresh data dir', async () => {
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);
		const asset = await seedAssetInDataDir(sourceDir);

		const bundleDir = join(makeTempDir(), 'bundle');
		expect(await runBackup(argv('backup', '--data-dir', sourceDir, '--output', bundleDir))).toBe(
			true,
		);
		// A bundle is a directory carrying the DB dump, the blob, and a manifest.
		expect((await stat(bundleDir)).isDirectory()).toBe(true);
		expect(existsSync(join(bundleDir, BUNDLE_MANIFEST_NAME))).toBe(true);
		expect(existsSync(join(bundleDir, BUNDLE_DB_NAME))).toBe(true);
		const bundledBlob = await readFile(
			join(bundleDir, BUNDLE_ASSETS_DIR, asset.projectId, asset.assetId),
		);
		expect(bundledBlob.equals(asset.content)).toBe(true);

		const targetDir = makeTempDir();
		expect(await runRestore(argv('restore', bundleDir, '--data-dir', targetDir))).toBe(true);

		const restored = await openDatabase({ dataDir: targetDir });
		try {
			expect(await teamSlugs(restored.db)).toContain('backup-probe');
		} finally {
			await safeClose(restored.db as { close: () => Promise<void> });
		}
		const restoredBlob = await new LocalAssetStore(targetDir).read(asset.projectId, asset.assetId);
		expect(restoredBlob.equals(asset.content)).toBe(true);
	}, 120_000);

	it('migrates a bundle’s assets into an S3-compatible bucket named by env', async () => {
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);
		const asset = await seedAssetInDataDir(sourceDir);
		const bundleDir = join(makeTempDir(), 'bundle-s3');
		expect(await runBackup(argv('backup', '--data-dir', sourceDir, '--output', bundleDir))).toBe(
			true,
		);

		const sim = await createS3Sim();
		sims.push(sim);
		// HEZO_ASSET_STORAGE_URL (env) resolves the target store, mirroring --database-url.
		process.env.HEZO_ASSET_STORAGE_URL = sim.storeUrl();
		expect(await runRestore(argv('restore', bundleDir, '--data-dir', makeTempDir()))).toBe(true);
		expect(sim.objects.get(`${asset.projectId}/${asset.assetId}`)?.body.equals(asset.content)).toBe(
			true,
		);
	}, 120_000);

	it('backs up database-only to a bare .backup.gz with --no-assets', async () => {
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);
		await seedAssetInDataDir(sourceDir);
		const output = join(makeTempDir(), 'db-only.backup.gz');
		expect(
			await runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets', '--output', output)),
		).toBe(true);
		expect((await stat(output)).isFile()).toBe(true);
		expect((await peekLogicalBackupHeaderFromFile(output))?.formatVersion).toBe(1);
	}, 120_000);

	it('backs up assets-only with --no-database and restores just the blobs', async () => {
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);
		const asset = await seedAssetInDataDir(sourceDir);

		const bundleDir = join(makeTempDir(), 'assets-only');
		expect(
			await runBackup(
				argv('backup', '--data-dir', sourceDir, '--no-database', '--output', bundleDir),
			),
		).toBe(true);
		expect(existsSync(join(bundleDir, BUNDLE_DB_NAME))).toBe(false);
		expect(existsSync(join(bundleDir, BUNDLE_ASSETS_DIR, asset.projectId, asset.assetId))).toBe(
			true,
		);

		// Restore assets-only back into the same instance (rows present → verified, idempotent).
		expect(await runRestore(argv('restore', bundleDir, '--data-dir', sourceDir))).toBe(true);
		const restored = await new LocalAssetStore(sourceDir).read(asset.projectId, asset.assetId);
		expect(restored.equals(asset.content)).toBe(true);
	}, 120_000);

	it('refuses --no-assets together with --no-database', async () => {
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);
		await expect(
			runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets', '--no-database')),
		).rejects.toThrow(/Nothing to back up/);
	});

	it('resolves the data dir from HEZO_DATA_DIR when --data-dir is not passed', async () => {
		// Reproduces the production report: an instance started with
		// HEZO_DATA_DIR (systemd/docker) never passes --data-dir, so backup must
		// read the env var rather than fall back to the default ~/.hezo and crash
		// on a freshly-created empty database (`relation "_migrations" does not exist`).
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);
		process.env.HEZO_DATA_DIR = sourceDir;

		const output = join(makeTempDir(), 'env-datadir.backup.gz');
		expect(await runBackup(argv('backup', '--no-assets', '--output', output))).toBe(true);
		const header = await peekLogicalBackupHeaderFromFile(output);
		expect(header?.formatVersion).toBe(1);
		expect(header?.migrations.length).toBeGreaterThan(0);

		// Restore also honours HEZO_DATA_DIR (no --data-dir flag) into a fresh dir.
		const targetDir = makeTempDir();
		process.env.HEZO_DATA_DIR = targetDir;
		expect(await runRestore(argv('restore', output))).toBe(true);
		const restored = await openDatabase({ dataDir: targetDir });
		try {
			expect(await teamSlugs(restored.db)).toContain('backup-probe');
		} finally {
			await safeClose(restored.db as { close: () => Promise<void> });
		}
	}, 120_000);

	it('fails with an actionable error (not a bare _migrations error) on a data dir with no Hezo database', async () => {
		// A wrong --data-dir / HEZO_DATA_DIR (or a never-started instance) opens an
		// empty PGlite database; backup must explain that rather than surface the raw
		// `relation "_migrations" does not exist`.
		const emptyDir = makeTempDir();
		await expect(runBackup(argv('backup', '--data-dir', emptyDir, '--no-assets'))).rejects.toThrow(
			/No Hezo database found/,
		);
		await expect(
			runBackup(argv('backup', '--data-dir', emptyDir, '--no-assets')),
		).rejects.not.toThrow(/relation "_migrations" does not exist/);
	}, 120_000);

	it('refuses an embedded backup while a server holds the data dir, then proceeds once it stops', async () => {
		// PGlite is single-process — backing up a live embedded instance opens a
		// second cluster over the same files. The running server drops an advisory
		// PID lock; the preflight must refuse while it's live.
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);

		// Simulate a live server: the lock carries this (alive) process's PID.
		writeInstanceLock(sourceDir);
		const output = join(makeTempDir(), 'locked.backup.gz');
		await expect(
			runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets', '--output', output)),
		).rejects.toThrow(/server appears to be running/);
		// The message names the live PID and the lock file to delete as the escape hatch.
		await expect(
			runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets', '--output', output)),
		).rejects.toThrow(new RegExp(`PID ${process.pid}\\b`));
		expect(existsSync(output)).toBe(false);

		// Stop the "server" → the same backup now succeeds, proving it was the lock,
		// not the data, that blocked it.
		removeInstanceLock(sourceDir);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		expect(
			await runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets', '--output', output)),
		).toBe(true);
		expect(existsSync(output)).toBe(true);
	}, 120_000);

	it('ignores a stale lock left by a crash (dead PID) and backs up normally', async () => {
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);
		// A PID no process could hold → liveness returns ESRCH → treated as stale.
		writeFileSync(instanceLockPath(sourceDir), '2147483646\n', 'utf8');
		const output = join(makeTempDir(), 'stale.backup.gz');
		expect(
			await runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets', '--output', output)),
		).toBe(true);
		expect(existsSync(output)).toBe(true);
	}, 120_000);

	it('refuses an embedded restore while a server holds the target data dir', async () => {
		// Take a valid backup from an unlocked source first.
		const sourceDir = makeTempDir();
		await seedMigratedDataDir(sourceDir);
		const output = join(makeTempDir(), 'for-restore.backup.gz');
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		expect(
			await runBackup(argv('backup', '--data-dir', sourceDir, '--no-assets', '--output', output)),
		).toBe(true);

		// The restore target is "in use" by a live server → refuse before writing.
		const targetDir = makeTempDir();
		writeInstanceLock(targetDir);
		await expect(runRestore(argv('restore', output, '--data-dir', targetDir))).rejects.toThrow(
			/server appears to be running/,
		);
		removeInstanceLock(targetDir);
	}, 120_000);
});
