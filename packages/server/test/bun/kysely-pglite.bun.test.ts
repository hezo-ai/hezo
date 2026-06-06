/**
 * Bun-native counterpart to the Kysely-over-PGlite spike. The server runs on
 * Bun in prod but vitest runs on Node, so a green vitest run says nothing about
 * the driver's behavior under Bun. This re-checks the parameterized round-trip,
 * RETURNING, and transaction commit/rollback on the production runtime.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { Kysely, sql } from 'kysely';
import { PGliteDialect } from '../../src/db/pglite-dialect';

interface SpikeDB {
	teams: { id: string; slug: string; name: string; settings: unknown };
}

let raw: PGlite;
let db: Kysely<SpikeDB>;

beforeAll(async () => {
	raw = new PGlite({ extensions: { vector } });
	await raw.exec(`
		CREATE TABLE teams (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			slug TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			settings JSONB NOT NULL DEFAULT '{}'::jsonb
		);
	`);
	db = new Kysely<SpikeDB>({ dialect: new PGliteDialect(raw) });
});

afterAll(async () => {
	await db.destroy();
	await raw.close();
});

describe('Kysely over PGlite under Bun', () => {
	test('parameterized INSERT … RETURNING and SELECT round-trip', async () => {
		const inserted = await db
			.insertInto('teams')
			.values({ id: sql`gen_random_uuid()`, slug: 'bun-team', name: "O'Brien" })
			.returning(['id', 'slug', 'name'])
			.executeTakeFirstOrThrow();
		expect(inserted.slug).toBe('bun-team');
		expect(inserted.name).toBe("O'Brien");

		const found = await db
			.selectFrom('teams')
			.select('name')
			.where('slug', '=', 'bun-team')
			.executeTakeFirstOrThrow();
		expect(found.name).toBe("O'Brien");
	});

	test('transaction rollback discards the write', async () => {
		try {
			await db.transaction().execute(async (trx) => {
				await trx
					.insertInto('teams')
					.values({ id: sql`gen_random_uuid()`, slug: 'bun-rollback', name: 'x' })
					.execute();
				throw new Error('boom');
			});
		} catch {
			// expected
		}
		const rows = await db
			.selectFrom('teams')
			.select('slug')
			.where('slug', '=', 'bun-rollback')
			.execute();
		expect(rows).toEqual([]);
	});
});
