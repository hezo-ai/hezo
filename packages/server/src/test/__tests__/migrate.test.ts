import { describe, expect, it, vi } from 'vitest';
import { createMemoryDb } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { safeClose } from '../helpers';

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
