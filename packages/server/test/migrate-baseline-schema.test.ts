import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import { loadMigrationSql, migrationsDir } from './helpers/migrate';
import { introspectSchema } from './helpers/schema-introspect';

// v1.0 migration-collapse guard.
//
// The historical 001..016 migration chain (plus the one code migration) was
// collapsed into a single fresh 001_initial_schema.sql baseline. Before deleting
// the old files, the chain's resulting schema was introspected once into
// test/fixtures/baseline-schema.snapshot.txt. This test asserts the collapsed
// single-file 001 reproduces that exact schema — it gated the collapse and now
// guards the frozen baseline against accidental drift.
//
// Do NOT regenerate the fixture from the current migrations: it represents the
// pre-collapse chain and overwriting it from 001 would make this test tautological.

test('collapsed 001 baseline reproduces the captured schema snapshot', async () => {
	const db = await createMemoryDb();
	try {
		await db.exec(loadMigrationSql('001_initial_schema.sql'));
		const actual = await introspectSchema(db);
		const expected = readFileSync(
			join(migrationsDir(), '..', 'test', 'fixtures', 'baseline-schema.snapshot.txt'),
			'utf-8',
		);
		expect(actual).toBe(expected);
	} finally {
		await db.close();
	}
});
