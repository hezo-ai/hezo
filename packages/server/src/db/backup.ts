import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { logger } from '../logger';

const log = logger.child('backup');

/** How many pre-migration snapshots to retain under `<dataDir>/backups`. */
const KEEP_BACKUPS = 5;

export interface BackupMeta {
	version: string;
	pending: string[];
}

/**
 * Snapshot the live PGlite data directory to `<dataDir>/backups` before
 * migrations mutate it. Uses PGlite's `dumpDataDir` (a consistent gzipped
 * tarball of the open database) rather than copying the on-disk `pgdata`
 * directory, which can be torn mid-write. Returns the tarball path so a failed
 * migration can point the operator at it for a manual downgrade.
 */
export async function backupDataDir(
	db: PGlite,
	dataDir: string,
	meta: BackupMeta,
): Promise<string> {
	const backupsDir = join(dataDir, 'backups');
	await mkdir(backupsDir, { recursive: true });

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const base = `pgdata-${stamp}-pre-${meta.version}`;
	const tarPath = join(backupsDir, `${base}.tar.gz`);
	const metaPath = join(backupsDir, `${base}.json`);

	const dump = await db.dumpDataDir('gzip');
	await writeFile(tarPath, Buffer.from(await dump.arrayBuffer()));
	await writeFile(
		metaPath,
		JSON.stringify(
			{
				createdAt: new Date().toISOString(),
				version: meta.version,
				pending: meta.pending,
				file: `${base}.tar.gz`,
			},
			null,
			2,
		),
	);

	log.info(`Backed up pgdata before migrations → ${tarPath}`);
	await pruneBackups(backupsDir);
	return tarPath;
}

async function pruneBackups(backupsDir: string): Promise<void> {
	const tarballs = (await readdir(backupsDir)).filter((f) => f.endsWith('.tar.gz')).sort();
	const excess = tarballs.slice(0, Math.max(0, tarballs.length - KEEP_BACKUPS));
	for (const f of excess) {
		const base = f.replace(/\.tar\.gz$/, '');
		await rm(join(backupsDir, f), { force: true });
		await rm(join(backupsDir, `${base}.json`), { force: true });
	}
}

/**
 * Restore a pre-migration snapshot into `<dataDir>/pgdata`, wiping the current
 * data directory first. After this the operator runs the matching (older) Hezo
 * binary. Used by the `hezo restore` CLI subcommand for manual downgrade.
 */
export async function restoreDataDir(dataDir: string, backupFile: string): Promise<void> {
	const { PGlite } = await import('@electric-sql/pglite');
	const { NodeFS } = await import('@electric-sql/pglite/nodefs');
	const { loadPgliteAssets } = await import('./pglite-assets');

	const pgDataPath = join(dataDir, 'pgdata');
	const bytes = await readFile(backupFile);
	const blob = new File([bytes as BlobPart], 'dump.tar.gz', { type: 'application/gzip' });

	// In the compiled binary PGlite's WASM/data come from the embedded assets;
	// in dev they resolve from node_modules.
	const assets = await loadPgliteAssets();

	await rm(pgDataPath, { recursive: true, force: true });
	const db = assets
		? new PGlite({
				fs: new NodeFS(pgDataPath),
				wasmModule: assets.wasmModule,
				fsBundle: assets.fsBundle,
				loadDataDir: blob,
			})
		: new PGlite({ fs: new NodeFS(pgDataPath), loadDataDir: blob });
	await db.query('SELECT 1');
	await db.close();
	log.info(`Restored pgdata from ${backupFile}`);
}
