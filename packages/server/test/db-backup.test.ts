import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDataDir, restoreDataDir } from '../src/db/backup';
import { openPersistentDb } from '../src/db/client';
import { PgliteDb } from '../src/db/drivers/pglite';
import { safeClose } from './helpers';

describe('pre-migration backup + restore', () => {
	let dataDir: string;

	afterEach(async () => {
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	it('snapshots the data dir and restores it after a wipe', async () => {
		dataDir = await mkdtemp(join(tmpdir(), 'hezo-backup-'));

		// Seed an instance with some data.
		let db = new PgliteDb(await openPersistentDb(dataDir));
		await db.exec('CREATE TABLE widgets (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
		await db.exec("INSERT INTO widgets (name) VALUES ('alpha'), ('beta')");

		const tarPath = await backupDataDir(db, dataDir, {
			version: '0.1.0',
			pending: ['002_next.sql'],
		});
		await safeClose(db);

		// Backup tarball + sidecar metadata landed under backups/.
		const backups = await readdir(join(dataDir, 'backups'));
		expect(backups).toContain(tarPath.split('/').pop());
		expect(backups.some((f) => f.endsWith('.json'))).toBe(true);

		// Simulate a botched migration by dropping the table, then restore.
		db = new PgliteDb(await openPersistentDb(dataDir));
		await db.exec('DROP TABLE widgets');
		await safeClose(db);

		await restoreDataDir(dataDir, tarPath);

		db = new PgliteDb(await openPersistentDb(dataDir));
		try {
			const rows = await db.query<{ name: string }>('SELECT name FROM widgets ORDER BY id');
			expect(rows.rows.map((r) => r.name)).toEqual(['alpha', 'beta']);
		} finally {
			await safeClose(db);
		}
	});
});
