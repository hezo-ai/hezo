import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import type { Db } from '../src/db/database';
import { PostgresDb } from '../src/db/drivers/postgres';
import { isFkViolation, isUniqueViolation } from '../src/lib/sql';
import { createScratchPostgres } from './helpers/scratch-postgres';

/**
 * Driver conformance contract: every `Db` implementation must satisfy these
 * assertions identically — result shapes, type parsing, error codes, and
 * transaction semantics. The PGlite leg always runs; the postgres leg runs
 * when `HEZO_TEST_DATABASE_URL` points at a real Postgres (the `test-postgres`
 * CI job provides one). A behavior difference between drivers is a bug in the
 * driver, not in this suite — PGlite's empirically-pinned behavior is the
 * contract the postgres driver configures its type parsers to match.
 */
interface DriverCase {
	name: string;
	available: boolean;
	create(): Promise<{ db: Db; cleanup(): Promise<void> }>;
}

const drivers: DriverCase[] = [
	{
		name: 'pglite',
		available: true,
		create: async () => {
			const db = await createMemoryDb();
			return { db, cleanup: () => db.close() };
		},
	},
	{
		// Real Postgres via HEZO_TEST_DATABASE_URL (the test-postgres CI job's
		// postgres:16 service). Each suite gets a scratch database so runs never
		// interfere.
		name: 'postgres',
		available: Boolean(process.env.HEZO_TEST_DATABASE_URL),
		create: async () => {
			const scratch = await createScratchPostgres('conf');
			const db = await PostgresDb.connect({ url: scratch.url });
			return {
				db,
				cleanup: async () => {
					await db.close();
					await scratch.drop();
				},
			};
		},
	},
];

describe.each(drivers.filter((d) => d.available))('database conformance: $name', (driver) => {
	let db: Db;
	let cleanup: () => Promise<void>;

	beforeAll(async () => {
		({ db, cleanup } = await driver.create());
		await db.exec(`
			CREATE TABLE conf_parents (
				id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				name TEXT NOT NULL,
				CONSTRAINT conf_parents_name_unique UNIQUE (name)
			);
			CREATE TABLE conf_children (
				id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
				parent_id UUID NOT NULL,
				CONSTRAINT conf_children_parent_fk FOREIGN KEY (parent_id) REFERENCES conf_parents (id)
			);
			CREATE TABLE conf_counter (id INT PRIMARY KEY, value INT NOT NULL);
			CREATE TYPE conf_status AS ENUM ('open', 'closed');
		`);
		await db.query('INSERT INTO conf_counter (id, value) VALUES (1, 0)');
	});

	afterAll(async () => {
		await cleanup();
	});

	it('returns rows with parsed column types matching the pinned contract', async () => {
		const r = await db.query<{
			c: number;
			big: number;
			f: number;
			n: string;
			b: boolean;
			j: { k: number };
			t: Date;
			arr: string[];
			u: string;
			by: Uint8Array;
			nul: string | null;
			status: string;
		}>(
			`SELECT COUNT(*) AS c, 1::int8 AS big, 1.5::float8 AS f, 2.5::numeric AS n,
			        true AS b, '{"k":1}'::jsonb AS j, now() AS t, ARRAY['a','b'] AS arr,
			        gen_random_uuid() AS u, '\\xdeadbeef'::bytea AS by, NULL::text AS nul,
			        'open'::conf_status AS status
			 FROM (VALUES (1),(2)) v(x)`,
		);
		const row = r.rows[0];
		// int8 (COUNT/BIGINT) parses to a JS number — several call sites do math
		// on uncast COUNT(*) results, so this is load-bearing for both drivers.
		expect(row.c).toBe(2);
		expect(typeof row.c).toBe('number');
		expect(row.big).toBe(1);
		expect(row.f).toBe(1.5);
		expect(row.n).toBe('2.5'); // numeric stays a string on both drivers
		expect(row.b).toBe(true);
		expect(row.j).toEqual({ k: 1 });
		expect(row.t).toBeInstanceOf(Date);
		expect(row.arr).toEqual(['a', 'b']);
		expect(typeof row.u).toBe('string');
		expect(row.u).toMatch(/^[0-9a-f-]{36}$/);
		expect(Array.from(row.by)).toEqual([0xde, 0xad, 0xbe, 0xef]);
		expect(row.nul).toBeNull();
		expect(row.status).toBe('open');
	});

	it('serializes jsonb + array parameters the way call sites pass them', async () => {
		await db.exec('CREATE TABLE IF NOT EXISTS conf_params (j JSONB, arr TEXT[])');
		// `buildUpdateSet` JSON.stringifies jsonb params and relies on ::jsonb casts.
		await db.query('INSERT INTO conf_params (j, arr) VALUES ($1::jsonb, $2)', [
			JSON.stringify({ nested: [1, 2] }),
			['x', 'y'],
		]);
		const r = await db.query<{ j: { nested: number[] }; arr: string[] }>(
			'SELECT j, arr FROM conf_params',
		);
		expect(r.rows[0].j).toEqual({ nested: [1, 2] });
		expect(r.rows[0].arr).toEqual(['x', 'y']);
	});

	it('surfaces FK and unique violations with SQLSTATE code + constraint name', async () => {
		await db.query("INSERT INTO conf_parents (name) VALUES ('dup')");
		const dup = db.query("INSERT INTO conf_parents (name) VALUES ('dup')");
		await expect(dup).rejects.toSatisfy((e: unknown) =>
			isUniqueViolation(e, 'conf_parents_name_unique'),
		);

		const orphan = db.query('INSERT INTO conf_children (parent_id) VALUES (gen_random_uuid())');
		await expect(orphan).rejects.toSatisfy((e: unknown) =>
			isFkViolation(e, 'conf_children_parent_fk'),
		);
	});

	it('executes multi-statement exec batches', async () => {
		await db.exec(`
			CREATE TABLE conf_multi (id INT);
			INSERT INTO conf_multi (id) VALUES (1);
			INSERT INTO conf_multi (id) VALUES (2);
		`);
		const r = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM conf_multi');
		expect(r.rows[0].c).toBe(2);
	});

	it('commits a transaction (explicit handle and closed-over db both pinned)', async () => {
		await db.transaction(async (tx) => {
			await tx.query("INSERT INTO conf_parents (name) VALUES ('via-tx')");
			// Closed-over `db` inside the block routes to the same transaction.
			await db.query("INSERT INTO conf_parents (name) VALUES ('via-db')");
		});
		const r = await db.query<{ c: number }>(
			"SELECT COUNT(*)::int AS c FROM conf_parents WHERE name IN ('via-tx', 'via-db')",
		);
		expect(r.rows[0].c).toBe(2);
	});

	it('rolls back everything on throw — including closed-over db writes', async () => {
		await expect(
			db.transaction(async (tx) => {
				await tx.query("INSERT INTO conf_parents (name) VALUES ('rb-tx')");
				await db.query("INSERT INTO conf_parents (name) VALUES ('rb-db')");
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		const r = await db.query<{ c: number }>(
			"SELECT COUNT(*)::int AS c FROM conf_parents WHERE name LIKE 'rb-%'",
		);
		expect(r.rows[0].c).toBe(0);
	});

	it('supports multi-statement exec inside a transaction (migration shape)', async () => {
		await db.transaction(async (tx) => {
			await tx.exec(`
				CREATE TABLE conf_mig (id INT);
				INSERT INTO conf_mig (id) VALUES (42);
			`);
			await tx.query('INSERT INTO conf_mig (id) VALUES (43)');
		});
		const r = await db.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM conf_mig');
		expect(r.rows[0].c).toBe(2);
	});

	it('joins nested transaction() calls into the ambient transaction', async () => {
		// Inner completion must not commit early: an outer throw after the inner
		// block returns rolls BOTH writes back.
		await expect(
			db.transaction(async (tx) => {
				await tx.query("INSERT INTO conf_parents (name) VALUES ('outer-w')");
				await db.transaction(async (inner) => {
					await inner.query("INSERT INTO conf_parents (name) VALUES ('inner-w')");
				});
				throw new Error('after inner');
			}),
		).rejects.toThrow('after inner');
		const rolled = await db.query<{ c: number }>(
			"SELECT COUNT(*)::int AS c FROM conf_parents WHERE name IN ('outer-w', 'inner-w')",
		);
		expect(rolled.rows[0].c).toBe(0);

		// And the happy path commits both.
		await db.transaction(async (tx) => {
			await tx.query("INSERT INTO conf_parents (name) VALUES ('outer-c')");
			await db.transaction(async (inner) => {
				await inner.query("INSERT INTO conf_parents (name) VALUES ('inner-c')");
			});
		});
		const committed = await db.query<{ c: number }>(
			"SELECT COUNT(*)::int AS c FROM conf_parents WHERE name IN ('outer-c', 'inner-c')",
		);
		expect(committed.rows[0].c).toBe(2);
	});

	it('serializes concurrent transactions (read-modify-write stays exact)', async () => {
		const N = 8;
		await Promise.all(
			Array.from({ length: N }, () =>
				db.transaction(async (tx) => {
					const cur = await tx.query<{ value: number }>(
						'SELECT value FROM conf_counter WHERE id = 1',
					);
					await tx.query('UPDATE conf_counter SET value = $1 WHERE id = 1', [
						cur.rows[0].value + 1,
					]);
				}),
			),
		);
		const final = await db.query<{ value: number }>('SELECT value FROM conf_counter WHERE id = 1');
		expect(final.rows[0].value).toBe(N);
	});

	it('rejects queries from async work that outlives its transaction', async () => {
		let leaked: Promise<unknown> | null = null;
		await db.transaction(async () => {
			// Scheduled inside the block, so it inherits the transaction context,
			// but it fires only after commit — must throw, not silently run
			// outside the transaction.
			leaked = new Promise((resolve, reject) => {
				setTimeout(() => db.query('SELECT 1').then(resolve, reject), 10);
			});
		});
		await expect(leaked).rejects.toThrow(/transaction completed/);
	});

	// The migration path serializes on a transaction-scoped advisory lock, so
	// every driver has to release one at the end of the transaction that took it -
	// including the transaction that ended by throwing.
	describe('transaction-scoped advisory locks', () => {
		const KEY = 424242;

		async function held(): Promise<number> {
			const r = await db.query<{ c: number }>(
				`SELECT COUNT(*)::int AS c FROM pg_locks
				 WHERE locktype = 'advisory' AND objid = $1
				   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
				[KEY],
			);
			return r.rows[0].c;
		}

		it('holds one for the life of the transaction, then releases it on commit', async () => {
			await db.transaction(async (tx) => {
				await tx.query('SELECT pg_advisory_xact_lock($1)', [KEY]);
				const inside = await tx.query<{ c: number }>(
					`SELECT COUNT(*)::int AS c FROM pg_locks
				 WHERE locktype = 'advisory' AND objid = $1
				   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
					[KEY],
				);
				expect(inside.rows[0].c).toBe(1);
			});
			expect(await held()).toBe(0);
		});

		it('releases it on rollback, so a failed migrator never wedges the next', async () => {
			await expect(
				db.transaction(async (tx) => {
					await tx.query('SELECT pg_advisory_xact_lock($1)', [KEY]);
					throw new Error('migration blew up');
				}),
			).rejects.toThrow('migration blew up');
			expect(await held()).toBe(0);
		});
	});
});
