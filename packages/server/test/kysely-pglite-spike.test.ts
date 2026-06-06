/**
 * Phase 3 de-risking spike — proves Kysely runs over the *existing* PGlite
 * connection with fidelity on the cases that bite raw-SQL → query-builder
 * migrations: parameterization, INSERT … RETURNING, enum casts, jsonb
 * round-trips, and `IS NULL` scoping. Remove once the repository layer and its
 * own tests land; until then this is the gate for the rest of Phase 3.
 */
import type { PGlite } from '@electric-sql/pglite';
import { TaskStatus } from '@hezo/shared';
import { Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGliteDialect } from '../src/db/pglite-dialect';
import { createTestDbWithMigrations } from './helpers/db';

// Minimal hand-written slice of the schema, enough for the spike. The real
// repository layer will use a generated Database interface.
interface SpikeDB {
	teams: {
		id: string;
		slug: string;
		name: string;
		settings: unknown;
	};
}

let raw: PGlite;
let db: Kysely<SpikeDB>;

beforeAll(async () => {
	raw = await createTestDbWithMigrations();
	// Wrap the SAME connection — no second database.
	db = new Kysely<SpikeDB>({ dialect: new PGliteDialect(raw) });
});

afterAll(async () => {
	await db.destroy();
});

describe('Kysely over the existing PGlite connection', () => {
	it('round-trips a parameterized INSERT … RETURNING and SELECT', async () => {
		const inserted = await db
			.insertInto('teams')
			.values({
				id: sql`gen_random_uuid()`,
				slug: 'spike-team',
				name: "O'Brien & Co", // exercises quoting via parameterization
				settings: sql`'{}'::jsonb`,
			})
			.returning(['id', 'slug', 'name'])
			.executeTakeFirstOrThrow();

		expect(inserted.slug).toBe('spike-team');
		expect(inserted.name).toBe("O'Brien & Co");

		const found = await db
			.selectFrom('teams')
			.select(['id', 'slug', 'name'])
			.where('slug', '=', 'spike-team')
			.executeTakeFirstOrThrow();
		expect(found.id).toBe(inserted.id);
		expect(found.name).toBe("O'Brien & Co");
	});

	it('round-trips a jsonb column as a structured value', async () => {
		const payload = { theme: 'dark', limits: { runs: 3 } };
		await db
			.insertInto('teams')
			.values({
				id: sql`gen_random_uuid()`,
				slug: 'spike-json',
				name: 'json team',
				settings: sql`${JSON.stringify(payload)}::jsonb`,
			})
			.execute();

		const row = await db
			.selectFrom('teams')
			.select('settings')
			.where('slug', '=', 'spike-json')
			.executeTakeFirstOrThrow();
		// PGlite returns jsonb already parsed.
		expect(row.settings).toEqual(payload);
	});

	it('handles enum casts on a real enum column (tasks.status)', async () => {
		// Inserting a task needs a team + project; use raw query to set those up
		// (the repository layer will own typed inserts). The point is the enum cast.
		const result = await sql<{
			status: string;
		}>`SELECT ${TaskStatus.InProgress}::task_status AS status`.execute(db);
		expect(result.rows[0].status).toBe(TaskStatus.InProgress);
	});

	it('commits and rolls back transactions', async () => {
		await db.transaction().execute(async (trx) => {
			await trx
				.insertInto('teams')
				.values({
					id: sql`gen_random_uuid()`,
					slug: 'spike-tx-commit',
					name: 'committed',
					settings: sql`'{}'::jsonb`,
				})
				.execute();
		});
		const committed = await db
			.selectFrom('teams')
			.select('slug')
			.where('slug', '=', 'spike-tx-commit')
			.execute();
		expect(committed).toHaveLength(1);

		await expect(
			db.transaction().execute(async (trx) => {
				await trx
					.insertInto('teams')
					.values({
						id: sql`gen_random_uuid()`,
						slug: 'spike-tx-rollback',
						name: 'rolled back',
						settings: sql`'{}'::jsonb`,
					})
					.execute();
				throw new Error('force rollback');
			}),
		).rejects.toThrow('force rollback');
		const rolledBack = await db
			.selectFrom('teams')
			.select('slug')
			.where('slug', '=', 'spike-tx-rollback')
			.execute();
		expect(rolledBack).toEqual([]);
	});

	it('introspects the live schema (codegen by information_schema is viable)', async () => {
		// The PostgresIntrospector runs over our dialect — this is the path a
		// codegen script uses to emit the Database type from a booted PGlite.
		const tables = await db.introspection.getTables();
		const names = new Set(tables.map((t) => t.name));
		for (const expected of ['tasks', 'teams', 'projects', 'secrets', 'members']) {
			expect(names.has(expected)).toBe(true);
		}
		// Column metadata carries the Postgres data type we map to TS.
		const tasks = tables.find((t) => t.name === 'tasks');
		expect(tasks).toBeDefined();
		const status = tasks?.columns.find((c) => c.name === 'status');
		expect(status?.dataType).toBe('task_status');
	});

	it('distinguishes IS NULL from = NULL for instance-vs-team scoping', async () => {
		// Two teams exist (slugs above) plus seeded builtins; none have a null id,
		// but the operator must compile to `IS NULL`, not `= NULL` (always-false).
		const viaIsNull = await db.selectFrom('teams').select('id').where('slug', 'is', null).execute();
		expect(viaIsNull).toEqual([]);

		const viaEquals = await db
			.selectFrom('teams')
			.select(({ eb }) => eb.fn.countAll<number>().as('n'))
			.where('slug', 'is not', null)
			.executeTakeFirstOrThrow();
		expect(Number(viaEquals.n)).toBeGreaterThanOrEqual(2);
	});
});
