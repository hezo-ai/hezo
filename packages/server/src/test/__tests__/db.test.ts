import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb, createMemoryDb } from '../../db/client';
import { safeClose } from '../helpers';

describe('PGlite client', () => {
	it('creates an in-memory database and executes queries', async () => {
		const db = await createMemoryDb();
		try {
			const result = await db.query<{ val: number }>('SELECT 1 + 1 AS val');
			expect(result.rows[0].val).toBe(2);
		} finally {
			await safeClose(db);
		}
	});

	it('persists data across restarts with filesystem storage', async () => {
		const tempDir = await mkdtemp(join(tmpdir(), 'hezo-db-test-'));

		try {
			const db1 = await createDb(tempDir);
			await db1.exec('CREATE TABLE test_persist (id SERIAL PRIMARY KEY, name TEXT NOT NULL)');
			await db1.query('INSERT INTO test_persist (name) VALUES ($1)', ['hello']);
			await safeClose(db1);

			const db2 = await createDb(tempDir);
			try {
				const result = await db2.query<{ name: string }>('SELECT name FROM test_persist');
				expect(result.rows).toHaveLength(1);
				expect(result.rows[0].name).toBe('hello');
			} finally {
				await safeClose(db2);
			}
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
