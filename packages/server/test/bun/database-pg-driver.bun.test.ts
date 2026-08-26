// Bun-native tier: node-postgres rides node:net/node:tls, whose behaviour
// diverges between Node (vitest) and the production Bun runtime — a green
// Node-only run would say nothing about production. Requires a reachable
// Postgres via HEZO_TEST_DATABASE_URL (the test-postgres CI job provides
// one); skips silently otherwise.
import { describe, expect, it } from 'bun:test';
import pg from 'pg';

// `connectionParameters` is a real property of pg's Client - it is what the
// driver actually resolved the URL into - but @types/pg does not declare it.
// Naming the shape here beats casting at each assertion, which would also
// silence a genuine change to what the driver parses.
type ClientWithParams = pg.Client & {
	connectionParameters: { ssl?: unknown; host?: string; port?: number; database?: string };
};

import { PostgresDb } from '../../src/db/drivers/postgres';
import { normalizePostgresUrl } from '../../src/db/postgres-url';

const url = process.env.HEZO_TEST_DATABASE_URL;

// Needs no server: proves the connection-string parser resolves TLS the same
// way on the production runtime as it does under Node in the vitest tier.
describe('sslmode resolution on the Bun runtime', () => {
	it('reads sslmode=require as encrypted-but-unverified, matching libpq', () => {
		const { url: normalized, tls } = normalizePostgresUrl(
			'postgres://u:p@db.example:5432/hezo?sslmode=require',
			{},
		);
		expect(tls).toBe('encrypted');
		expect(
			(new pg.Client({ connectionString: normalized }) as ClientWithParams).connectionParameters
				.ssl,
		).toEqual({
			rejectUnauthorized: false,
		});
	});

	it('leaves sslmode=verify-full fully verifying', () => {
		const { url: normalized, tls } = normalizePostgresUrl(
			'postgres://u:p@db.example:5432/hezo?sslmode=verify-full',
			{},
		);
		expect(tls).toBe('verified');
		expect(
			(new pg.Client({ connectionString: normalized }) as ClientWithParams).connectionParameters
				.ssl,
		).toEqual({});
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

	// A pool of one is the dense-deployment setting, and it only works because
	// nothing holds a connection outside a transaction any more. On the real
	// driver rather than PGlite, because PGlite has a single connection anyway
	// and so could never show this failing.
	it('migrates on a pool of one, holding a transaction-scoped lock', async () => {
		const db = await PostgresDb.connect({ url: url as string, max: 1 });
		try {
			await db.transaction(async (tx) => {
				await tx.query('SELECT pg_advisory_xact_lock($1)', [52_4242]);
				// A query inside the block routes onto the transaction's own
				// connection, so it cannot deadlock waiting for a second one.
				await tx.query('SELECT 1');
			});
			const r = await db.query<{ c: number }>(
				"SELECT COUNT(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND objid = $1",
				[52_4242],
			);
			expect(r.rows[0].c).toBe(0);
		} finally {
			await db.close();
		}
	});
});
