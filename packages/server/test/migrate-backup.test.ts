import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupDataDir } from '../src/db/backup';
import { openPersistentDb } from '../src/db/client';
import { PgliteDb } from '../src/db/drivers/pglite';
import { getPendingMigrations, runMigrations } from '../src/db/migrate';
import { safeClose } from './helpers';

// HID-188: covers `backupDataDir` against a disk-backed PGlite — a gzipped
// snapshot of pgdata that survives a destructive refactor. Startup's automatic
// migration path no longer calls this (copy-migrate-swap leaves the original
// pgdata untouched on failure and keeps the prior pgdata aside on success), but
// `backupDataDir`/`restoreDataDir` remain the engine behind the manual
// `hezo restore` snapshot/downgrade flow, so the round-trip stays under test.

describe('migration backup-then-migrate (persistent, production path)', () => {
	it('snapshots pgdata before applying pending refactor migrations and preserves data', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-mig-backup-'));
		let db: PgliteDb | undefined;
		try {
			db = new PgliteDb(await openPersistentDb(dir));

			const migrations: Record<string, string> = {
				'001_posts.sql': `
					CREATE TABLE posts (
						id           SERIAL PRIMARY KEY,
						title        TEXT NOT NULL,
						author_name  TEXT NOT NULL,
						author_email TEXT NOT NULL
					);
				`,
				'002_extract_authors.sql': `
					CREATE TABLE authors (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE);
					INSERT INTO authors (name, email) SELECT DISTINCT author_name, author_email FROM posts;
					ALTER TABLE posts ADD COLUMN author_id INTEGER;
					UPDATE posts p SET author_id = a.id FROM authors a WHERE a.email = p.author_email;
					ALTER TABLE posts ALTER COLUMN author_id SET NOT NULL;
					ALTER TABLE posts ADD CONSTRAINT posts_author_fk FOREIGN KEY (author_id) REFERENCES authors (id);
					ALTER TABLE posts DROP COLUMN author_name;
					ALTER TABLE posts DROP COLUMN author_email;
				`,
				'003_split_author_name.sql': `
					ALTER TABLE authors ADD COLUMN first_name TEXT;
					ALTER TABLE authors ADD COLUMN last_name  TEXT;
					UPDATE authors SET first_name = split_part(name, ' ', 1), last_name = split_part(name, ' ', 2);
					ALTER TABLE authors ALTER COLUMN first_name SET NOT NULL;
					ALTER TABLE authors ALTER COLUMN last_name  SET NOT NULL;
					ALTER TABLE authors DROP COLUMN name;
				`,
			};

			// Simulate an existing instance: only v1 is installed, with live data.
			await runMigrations(db, { '001_posts.sql': migrations['001_posts.sql'] });
			const seed: Array<{ title: string; name: string; email: string }> = [
				{ title: 'First', name: 'Ada Lovelace', email: 'ada@example.com' },
				{ title: 'Second', name: 'Alan Turing', email: 'alan@example.com' },
				{ title: 'Third', name: 'Ada Lovelace', email: 'ada@example.com' },
			];
			for (const row of seed) {
				await db.query('INSERT INTO posts (title, author_name, author_email) VALUES ($1, $2, $3)', [
					row.title,
					row.name,
					row.email,
				]);
			}

			// Mirror runAvailableMigrations: an existing instance has applied rows,
			// and there are pending refactors to run.
			const appliedBefore = await db.query<{ c: number }>(
				'SELECT COUNT(*)::int AS c FROM _migrations',
			);
			expect(appliedBefore.rows[0].c).toBeGreaterThan(0);
			const pending = await getPendingMigrations(db, migrations);
			expect(pending).toEqual(['002_extract_authors.sql', '003_split_author_name.sql']);

			// Backup before mutating (same call shape as startup.ts:444).
			const tarPath = await backupDataDir(db, dir, { version: 'test-1.0.0', pending });
			expect(existsSync(tarPath)).toBe(true);
			const backups = readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.tar.gz'));
			expect(backups).toHaveLength(1);

			// Now apply the pending refactors.
			await runMigrations(db, migrations);

			// Every post still maps to its original author, with the split name intact.
			const joined = await db.query<{
				title: string;
				first_name: string;
				last_name: string;
				email: string;
			}>(
				`SELECT p.title, a.first_name, a.last_name, a.email
				 FROM posts p JOIN authors a ON a.id = p.author_id
				 ORDER BY p.id`,
			);
			expect(joined.rows).toEqual([
				{ title: 'First', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
				{ title: 'Second', first_name: 'Alan', last_name: 'Turing', email: 'alan@example.com' },
				{ title: 'Third', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
			]);
			const authorCount = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM authors');
			expect(authorCount.rows[0].c).toBe(2);
		} finally {
			if (db) await safeClose(db);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
