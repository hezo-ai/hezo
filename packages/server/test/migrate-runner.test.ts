import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPersistentDb } from '../src/db/client';
import type { Db } from '../src/db/database';
import { PgliteDb } from '../src/db/drivers/pglite';
import { type Migration, runMigrations } from '../src/db/migrate';
import { DbNewerThanAppError, MigrationFailedError } from '../src/db/migrate-errors';
import { applyPendingMigrations } from '../src/db/migrate-runner';
import { safeClose } from './helpers';

// HID-188: end-to-end coverage for applyPendingMigrations — the startup
// orchestrator that protects user data across upgrades. An existing instance is
// migrated against a COPY of pgdata, swapped in only on success; on failure the
// original is left untouched (so a downgraded binary just runs). It also refuses
// to run against a data dir carrying migrations the binary doesn't recognize.

const V1: Migration =
	'CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL);';

// A real refactor: extract authors into their own table + FK, preserving data.
const V2_EXTRACT_AUTHORS: Migration = `
	CREATE TABLE authors (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
	INSERT INTO authors (name) SELECT DISTINCT author FROM posts;
	ALTER TABLE posts ADD COLUMN author_id INTEGER;
	UPDATE posts p SET author_id = a.id FROM authors a WHERE a.name = p.author;
	ALTER TABLE posts ALTER COLUMN author_id SET NOT NULL;
	ALTER TABLE posts ADD CONSTRAINT posts_author_fk FOREIGN KEY (author_id) REFERENCES authors (id);
	ALTER TABLE posts DROP COLUMN author;
`;

describe('applyPendingMigrations', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	function tempDir(): string {
		const d = mkdtempSync(join(tmpdir(), 'hezo-mig-runner-'));
		dirs.push(d);
		return d;
	}

	async function seedExistingInstance(dir: string): Promise<void> {
		const db = new PgliteDb(await openPersistentDb(dir));
		await runMigrations(db, { '001_posts.sql': V1 });
		await db.query(
			"INSERT INTO posts (id, title, author) VALUES (1, 'A', 'Ada'), (2, 'B', 'Alan'), (3, 'C', 'Ada')",
		);
		await safeClose(db);
	}

	it('copy-migrate-swaps an existing instance and preserves data', async () => {
		const dir = tempDir();
		await seedExistingInstance(dir);

		let db: Db = new PgliteDb(await openPersistentDb(dir));
		db = await applyPendingMigrations(db, dir, {
			'001_posts.sql': V1,
			'002_extract_authors.sql': V2_EXTRACT_AUTHORS,
		});
		try {
			// Data survived the refactor through the swapped-in copy.
			const joined = await db.query<{ title: string; name: string }>(
				'SELECT p.title, a.name FROM posts p JOIN authors a ON a.id = p.author_id ORDER BY p.id',
			);
			expect(joined.rows).toEqual([
				{ title: 'A', name: 'Ada' },
				{ title: 'B', name: 'Alan' },
				{ title: 'C', name: 'Ada' },
			]);
			// Temp copy cleaned up; previous pgdata kept aside.
			expect(existsSync(join(dir, '.migrate-tmp'))).toBe(false);
			expect(existsSync(join(dir, 'pgdata'))).toBe(true);
			expect(readdirSync(dir).some((e) => e.startsWith('pgdata.superseded.'))).toBe(true);
		} finally {
			await safeClose(db);
		}
	});

	it('leaves the original database untouched when a migration fails', async () => {
		const dir = tempDir();
		await seedExistingInstance(dir);

		const db = new PgliteDb(await openPersistentDb(dir));
		await expect(
			applyPendingMigrations(db, dir, {
				'001_posts.sql': V1,
				'002_bad.sql': 'THIS IS NOT VALID SQL;',
			}),
		).rejects.toBeInstanceOf(MigrationFailedError);

		// applyPendingMigrations closed the handle it was given; reopen the dir and
		// confirm the original schema + data are exactly as before.
		expect(existsSync(join(dir, '.migrate-tmp'))).toBe(false);
		const reopened = new PgliteDb(await openPersistentDb(dir));
		try {
			const rows = await reopened.query<{ id: number; title: string; author: string }>(
				'SELECT id, title, author FROM posts ORDER BY id',
			);
			expect(rows.rows).toEqual([
				{ id: 1, title: 'A', author: 'Ada' },
				{ id: 2, title: 'B', author: 'Alan' },
				{ id: 3, title: 'C', author: 'Ada' },
			]);
			const applied = await reopened.query<{ filename: string }>(
				'SELECT filename FROM _migrations ORDER BY id',
			);
			expect(applied.rows.map((r) => r.filename)).toEqual(['001_posts.sql']);
		} finally {
			await safeClose(reopened);
		}
	});

	it('migrates a fresh install in place (no copy)', async () => {
		const dir = tempDir();
		const db = new PgliteDb(await openPersistentDb(dir));
		try {
			const returned = await applyPendingMigrations(db, dir, { '001_posts.sql': V1 });
			expect(returned).toBe(db); // same handle — no swap
			await returned.query("INSERT INTO posts (id, title, author) VALUES (1, 'A', 'Ada')");
			expect(existsSync(join(dir, '.migrate-tmp'))).toBe(false);
			expect(readdirSync(dir).some((e) => e.startsWith('pgdata.superseded.'))).toBe(false);
		} finally {
			await safeClose(db);
		}
	});

	it('refuses to run against a DB newer than the binary', async () => {
		const dir = tempDir();
		// DB has 001 + 002 applied...
		let db = new PgliteDb(await openPersistentDb(dir));
		await runMigrations(db, {
			'001_posts.sql': V1,
			'002_extra.sql': 'CREATE TABLE extra (id INT);',
		});
		await safeClose(db);

		// ...but this binary only knows 001.
		db = new PgliteDb(await openPersistentDb(dir));
		try {
			await expect(applyPendingMigrations(db, dir, { '001_posts.sql': V1 })).rejects.toBeInstanceOf(
				DbNewerThanAppError,
			);
			// Guard runs before any close/copy — the handle is still usable.
			const ok = await db.query<{ one: number }>('SELECT 1 AS one');
			expect(ok.rows[0].one).toBe(1);
		} finally {
			await safeClose(db);
		}
	});

	it('is a no-op when nothing is pending', async () => {
		const dir = tempDir();
		await seedExistingInstance(dir);
		const db = new PgliteDb(await openPersistentDb(dir));
		try {
			const returned = await applyPendingMigrations(db, dir, { '001_posts.sql': V1 });
			expect(returned).toBe(db);
			expect(existsSync(join(dir, '.migrate-tmp'))).toBe(false);
		} finally {
			await safeClose(db);
		}
	});
});
