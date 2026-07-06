import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runBackup, runRestore } from '../src/cli';
import { backupDataDir } from '../src/db/backup';
import type { Db } from '../src/db/database';
import type { PgliteDb } from '../src/db/drivers/pglite';
import { readLogicalBackupHeader } from '../src/db/logical-backup';
import { runMigrations } from '../src/db/migrate';
import { openDatabase } from '../src/db/open';
import { BASE_SCHEMA } from '../src/db/schema';
import { safeClose } from './helpers';
import { allMigrations } from './helpers/migrate';

// Exercises the `hezo backup` / `hezo restore` subcommands end-to-end against
// real embedded databases on disk — the same open/migrate/dump/restore code the
// CLI runs in production.

const argv = (...tokens: string[]) => ['bun', 'src/index.ts', ...tokens];

const tempDirs: string[] = [];
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

describe('hezo backup / hezo restore subcommands', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let prevDatabaseUrl: string | undefined;

	beforeAll(() => {
		prevDatabaseUrl = process.env.HEZO_DATABASE_URL;
		delete process.env.HEZO_DATABASE_URL;
	});

	afterAll(() => {
		if (prevDatabaseUrl === undefined) delete process.env.HEZO_DATABASE_URL;
		else process.env.HEZO_DATABASE_URL = prevDatabaseUrl;
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.HEZO_DATABASE_URL;
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

		// Explicit --output path.
		const output = join(makeTempDir(), 'probe.backup.gz');
		expect(await runBackup(argv('backup', '--data-dir', sourceDir, '--output', output))).toBe(true);
		expect(existsSync(output)).toBe(true);
		const header = readLogicalBackupHeader(await readFile(output));
		expect(header?.formatVersion).toBe(1);
		expect(header?.migrations.length).toBeGreaterThan(0);
		expect(
			logSpy.mock.calls.some((c) => String(c[0]).includes('Wrote logical backup of embedded')),
		).toBe(true);

		// Default output path lands under <data-dir>/backups.
		expect(await runBackup(argv('backup', '--data-dir', sourceDir))).toBe(true);
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

	it('restores a legacy pgdata tarball into the embedded database', async () => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const sourceDir = makeTempDir();
		const opened = await openDatabase({ dataDir: sourceDir });
		let tarPath: string;
		try {
			await opened.db.exec('CREATE TABLE legacy_probe (id SERIAL PRIMARY KEY, name TEXT)');
			await opened.db.exec("INSERT INTO legacy_probe (name) VALUES ('alpha')");
			tarPath = await backupDataDir(opened.db as PgliteDb, sourceDir, {
				version: '0.0.1',
				pending: [],
			});
		} finally {
			await safeClose(opened.db as { close: () => Promise<void> });
		}

		const targetDir = makeTempDir();
		expect(await runRestore(argv('restore', tarPath, '--data-dir', targetDir))).toBe(true);

		const restored = await openDatabase({ dataDir: targetDir });
		try {
			const rows = await restored.db.query<{ name: string }>('SELECT name FROM legacy_probe');
			expect(rows.rows.map((r) => r.name)).toEqual(['alpha']);
		} finally {
			await safeClose(restored.db as { close: () => Promise<void> });
		}
	}, 120_000);

	it('refuses to restore a legacy tarball into an external database and exits 1', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as never);

		// Any non-logical file reads as a legacy snapshot (header parse → null).
		const dir = makeTempDir();
		const fakeTar = join(dir, 'legacy.tar.gz');
		writeFileSync(fakeTar, 'definitely not a logical backup');

		// --database-url flag variant (pickDatabaseUrl CLI branch).
		await expect(
			runRestore(argv('restore', fakeTar, '--database-url', 'postgres://u:p@h:5432/db')),
		).rejects.toThrow('process.exit(1)');
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('legacy pgdata snapshot'))).toBe(
			true,
		);

		// Env variant — HEZO_DATABASE_URL wins over the (absent) flag.
		errorSpy.mockClear();
		process.env.HEZO_DATABASE_URL = 'postgres://u:p@h:5432/db';
		await expect(runRestore(argv('restore', fakeTar))).rejects.toThrow('process.exit(1)');
		expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('legacy pgdata snapshot'))).toBe(
			true,
		);
	});
});
