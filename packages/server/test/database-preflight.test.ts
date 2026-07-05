import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import type { Queryable, QueryResult } from '../src/db/database';
import { ExternalDbError } from '../src/db/migrate-errors';
import {
	assertExternalPostgresCompatible,
	MIN_SERVER_VERSION_NUM,
} from '../src/db/postgres-preflight';

function stubDb(versionNum: number, opts: { uuidFails?: boolean } = {}): Queryable {
	return {
		async query<T>(sql: string): Promise<QueryResult<T>> {
			if (sql.includes('server_version_num')) {
				const major = Math.floor(versionNum / 10_000);
				return {
					rows: [{ num: versionNum, version: `${major}.1` } as T],
				};
			}
			if (sql.includes('gen_random_uuid')) {
				if (opts.uuidFails) throw new Error('function gen_random_uuid() does not exist');
				return { rows: [] };
			}
			throw new Error(`unexpected query: ${sql}`);
		},
		async exec() {},
	};
}

describe('assertExternalPostgresCompatible', () => {
	it('accepts a server at or above the floor and reports its version', async () => {
		const result = await assertExternalPostgresCompatible(stubDb(160_004));
		expect(result.serverVersionNum).toBe(160_004);
		expect(result.serverVersion).toBe('16.1');
	});

	it('rejects servers below the version floor with upgrade guidance', async () => {
		const attempt = assertExternalPostgresCompatible(stubDb(130_011));
		await expect(attempt).rejects.toBeInstanceOf(ExternalDbError);
		await expect(attempt).rejects.toThrow(/requires PostgreSQL 14 or newer/);
		await expect(attempt).rejects.toThrow(/13\.1/);
	});

	it('rejects when gen_random_uuid() is unavailable', async () => {
		const attempt = assertExternalPostgresCompatible(stubDb(150_000, { uuidFails: true }));
		await expect(attempt).rejects.toBeInstanceOf(ExternalDbError);
		await expect(attempt).rejects.toThrow(/gen_random_uuid/);
	});

	it('passes against a real PG16 engine (PGlite)', async () => {
		const db = await createMemoryDb();
		try {
			const result = await assertExternalPostgresCompatible(db);
			expect(result.serverVersionNum).toBeGreaterThanOrEqual(MIN_SERVER_VERSION_NUM);
		} finally {
			await db.close();
		}
	});
});
