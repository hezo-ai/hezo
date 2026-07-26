// Bun-native tier: node-postgres rides node:net/node:tls, whose behaviour
// diverges between Node (vitest) and the production Bun runtime — a green
// Node-only run would say nothing about production. Requires a reachable
// Postgres via HEZO_TEST_DATABASE_URL (the test-postgres CI job provides
// one); skips silently otherwise.
import { describe, expect, it } from 'bun:test';
import pg from 'pg';
import { PostgresDb } from '../../src/db/drivers/postgres';
import { planPostgresSsl } from '../../src/db/postgres-ssl';

const url = process.env.HEZO_TEST_DATABASE_URL;

// Needs no server: proves TLS resolves the same way on the production runtime
// as it does under Node in the vitest tier, and that the string handed to
// node-postgres no longer carries a mode that could override it.
describe('sslmode resolution on the Bun runtime', () => {
	it('reads sslmode=require as encrypted-but-unverified, matching libpq', () => {
		const plan = planPostgresSsl('postgres://u:p@db.example:5432/hezo?sslmode=require', {});
		expect(plan.tls).toBe('encrypted');
		expect(plan.ssl).toMatchObject({ rejectUnauthorized: false });
		// The stripped string leaves the parser with no TLS opinion of its own.
		expect(
			new pg.Client({ connectionString: plan.connectionString }).connectionParameters.ssl,
		).toBeFalsy();
	});

	it('leaves sslmode=verify-full fully verifying', () => {
		const plan = planPostgresSsl('postgres://u:p@db.example:5432/hezo?sslmode=verify-full', {});
		expect(plan.tls).toBe('verified');
		expect(plan.ssl).toMatchObject({ rejectUnauthorized: true });
	});

	it('offers TLS even when the URL says nothing about it', () => {
		const plan = planPostgresSsl('postgres://u:p@db.example:5432/hezo', {});
		expect(plan.tls).toBe('encrypted');
		expect(plan.plaintextFallback).toBe(true);
	});
});

describe.skipIf(!url)('PostgresDb on the Bun runtime', () => {
	it('connects, queries with parity-parsed types, and closes', async () => {
		const db = await PostgresDb.connect({ url: url as string });
		try {
			const r = await db.query<{ c: number; b: boolean; j: { k: number } }>(
				`SELECT COUNT(*) AS c, true AS b, '{"k":1}'::jsonb AS j FROM (VALUES (1),(2)) v(x)`,
			);
			expect(r.rows[0].c).toBe(2); // int8 parses to number (PGlite parity)
			expect(r.rows[0].b).toBe(true);
			expect(r.rows[0].j.k).toBe(1);
		} finally {
			await db.close();
		}
	});

	it('pins transactions and rolls back closed-over writes on throw', async () => {
		const db = await PostgresDb.connect({ url: url as string });
		try {
			const table = `bun_tx_probe_${Date.now().toString(36)}`;
			await db.exec(`CREATE TABLE ${table} (id INT)`);
			try {
				await db
					.transaction(async (tx) => {
						await tx.query(`INSERT INTO ${table} (id) VALUES (1)`);
						// Closed-over handle joins the same transaction.
						await db.query(`INSERT INTO ${table} (id) VALUES (2)`);
						throw new Error('boom');
					})
					.catch((e: Error) => {
						expect(e.message).toBe('boom');
					});
				const r = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table}`);
				expect(r.rows[0].c).toBe(0);

				await db.transaction(async (tx) => {
					await tx.query(`INSERT INTO ${table} (id) VALUES (3)`);
				});
				const committed = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table}`);
				expect(committed.rows[0].c).toBe(1);
			} finally {
				await db.exec(`DROP TABLE ${table}`);
			}
		} finally {
			await db.close();
		}
	});

	it('acquires and releases session advisory locks', async () => {
		const db = await PostgresDb.connect({ url: url as string });
		try {
			const lock = await db.acquireSessionLock(52_4242);
			await lock.release();
			const r = await db.query<{ held: boolean }>('SELECT pg_advisory_unlock(524242) AS held');
			expect(r.rows[0].held).toBe(false);
		} finally {
			await db.close();
		}
	});
});
