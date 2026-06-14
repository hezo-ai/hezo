import { describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import {
	findUnknownAppliedMigrations,
	getPendingMigrations,
	runMigrations,
} from '../src/db/migrate';
import { safeClose } from './helpers';

describe('migration runner', () => {
	it('creates _migrations table and applies migrations', async () => {
		const db = await createMemoryDb();
		try {
			const migrations = {
				'001_test.sql': 'CREATE TABLE test_table (id SERIAL PRIMARY KEY, name TEXT NOT NULL);',
			};

			await runMigrations(db, migrations);

			const tables = await db.query<{ tablename: string }>(
				"SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = '_migrations'",
			);
			expect(tables.rows).toHaveLength(1);

			const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
			expect(applied.rows).toHaveLength(1);
			expect(applied.rows[0].filename).toBe('001_test.sql');

			const testRows = await db.query('SELECT * FROM test_table');
			expect(testRows.rows).toHaveLength(0);
		} finally {
			await safeClose(db);
		}
	});

	it('skips already-applied migrations on second run', async () => {
		const db = await createMemoryDb();
		try {
			const migrations = {
				'001_test.sql': 'CREATE TABLE test_table (id SERIAL PRIMARY KEY, name TEXT NOT NULL);',
			};

			await runMigrations(db, migrations);
			await runMigrations(db, migrations);

			const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
			expect(applied.rows).toHaveLength(1);
		} finally {
			await safeClose(db);
		}
	});

	it('warns when a migration checksum has changed', async () => {
		const db = await createMemoryDb();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		try {
			await runMigrations(db, {
				'001_test.sql': 'CREATE TABLE test_table (id SERIAL PRIMARY KEY);',
			});

			await runMigrations(db, {
				'001_test.sql': 'CREATE TABLE test_table (id SERIAL PRIMARY KEY, name TEXT);',
			});

			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('001_test.sql'));
		} finally {
			logSpy.mockRestore();
			await safeClose(db);
		}
	});

	it('reports pending migrations before and after applying', async () => {
		const db = await createMemoryDb();
		try {
			const migrations = {
				'001_a.sql': 'CREATE TABLE a (id SERIAL PRIMARY KEY);',
				'002_b.sql': 'CREATE TABLE b (id SERIAL PRIMARY KEY);',
			};

			// No `_migrations` table yet → everything pending, sorted.
			expect(await getPendingMigrations(db, migrations)).toEqual(['001_a.sql', '002_b.sql']);

			await runMigrations(db, { '001_a.sql': migrations['001_a.sql'] });
			expect(await getPendingMigrations(db, migrations)).toEqual(['002_b.sql']);

			await runMigrations(db, migrations);
			expect(await getPendingMigrations(db, migrations)).toEqual([]);
		} finally {
			await safeClose(db);
		}
	});

	it('rolls back a failed migration', async () => {
		const db = await createMemoryDb();
		try {
			const migrations = {
				'001_good.sql': 'CREATE TABLE good_table (id SERIAL PRIMARY KEY);',
				'002_bad.sql': 'THIS IS NOT VALID SQL;',
			};

			await expect(runMigrations(db, migrations)).rejects.toThrow('002_bad.sql');

			const applied = await db.query<{ filename: string }>('SELECT filename FROM _migrations');
			expect(applied.rows).toHaveLength(1);
			expect(applied.rows[0].filename).toBe('001_good.sql');

			const badTable = await db.query<{ tablename: string }>(
				"SELECT tablename FROM pg_tables WHERE tablename = 'bad_table'",
			);
			expect(badTable.rows).toHaveLength(0);
		} finally {
			await safeClose(db);
		}
	});
});

describe('findUnknownAppliedMigrations', () => {
	it('returns applied migrations the binary does not know about (newer DB)', async () => {
		const db = await createMemoryDb();
		try {
			// Simulate a DB migrated by a newer binary: 001 + 002 applied...
			await runMigrations(db, {
				'001_a.sql': 'CREATE TABLE a (id SERIAL PRIMARY KEY);',
				'002_b.sql': 'CREATE TABLE b (id SERIAL PRIMARY KEY);',
			});
			// ...but this binary only ships 001.
			expect(
				await findUnknownAppliedMigrations(db, { '001_a.sql': 'CREATE TABLE a (...);' }),
			).toEqual(['002_b.sql']);
		} finally {
			await safeClose(db);
		}
	});

	it('returns [] when every applied migration is known', async () => {
		const db = await createMemoryDb();
		try {
			const migrations = {
				'001_a.sql': 'CREATE TABLE a (id SERIAL PRIMARY KEY);',
				'002_b.sql': 'CREATE TABLE b (id SERIAL PRIMARY KEY);',
			};
			await runMigrations(db, migrations);
			expect(await findUnknownAppliedMigrations(db, migrations)).toEqual([]);
		} finally {
			await safeClose(db);
		}
	});

	it('returns [] for a brand-new DB with no _migrations table', async () => {
		const db = await createMemoryDb();
		try {
			expect(await findUnknownAppliedMigrations(db, { '001_a.sql': 'SELECT 1;' })).toEqual([]);
		} finally {
			await safeClose(db);
		}
	});
});
