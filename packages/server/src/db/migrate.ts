import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';

export async function runMigrations(db: PGlite, migrations: Record<string, string>): Promise<void> {
	await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum    TEXT NOT NULL
    );
  `);

	const applied = await db.query<{ filename: string; checksum: string }>(
		'SELECT filename, checksum FROM _migrations ORDER BY id',
	);
	const appliedMap = new Map(applied.rows.map((r) => [r.filename, r.checksum]));

	const filenames = Object.keys(migrations).sort();

	for (const filename of filenames) {
		const sql = migrations[filename];
		const checksum = createHash('sha256').update(sql).digest('hex');

		if (appliedMap.has(filename)) {
			if (appliedMap.get(filename) !== checksum) {
				console.warn(`Warning: migration ${filename} has changed since it was applied`);
			}
			continue;
		}

		await db.exec('BEGIN');
		try {
			await db.exec(sql);
			await db.query('INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)', [
				filename,
				checksum,
			]);
			await db.exec('COMMIT');
			console.log(`Applied migration: ${filename}`);
		} catch (err) {
			await db.exec('ROLLBACK');
			throw new Error(`Migration ${filename} failed: ${err}`);
		}
	}
}

export async function loadBundledMigrations(): Promise<Record<string, string>> {
	const { unzip, list } = await import('@hiddentao/zip-json');
	const { readFile, mkdir, rm } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');

	const currentDir = new URL('.', import.meta.url).pathname;
	const bundlePath = join(currentDir, 'migrations-bundle.json');
	// biome-ignore lint/suspicious/noExplicitAny: JSON.parse returns unknown, zip-json expects its own type
	let archive: any;
	try {
		archive = JSON.parse(await readFile(bundlePath, 'utf-8'));
	} catch {
		throw new Error("Failed to load migration bundle. Run 'bun run build:migrations' first.");
	}

	const files = list(archive);
	const tmpExtractDir = join(tmpdir(), `hezo-migrations-${Date.now()}`);
	await mkdir(tmpExtractDir, { recursive: true });

	try {
		await unzip(archive, { outputDir: tmpExtractDir });
		const migrations: Record<string, string> = {};
		await Promise.all(
			files.map(async (file: { path: string }) => {
				migrations[file.path] = await readFile(join(tmpExtractDir, file.path), 'utf-8');
			}),
		);
		return migrations;
	} finally {
		await rm(tmpExtractDir, { recursive: true, force: true });
	}
}

export async function loadFilesystemMigrations(
	migrationsDir: string,
): Promise<Record<string, string>> {
	const { readdir, readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
	const migrations: Record<string, string> = {};
	await Promise.all(
		files.map(async (file) => {
			migrations[file] = await readFile(join(migrationsDir, file), 'utf-8');
		}),
	);
	return migrations;
}
