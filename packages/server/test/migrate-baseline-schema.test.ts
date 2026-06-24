import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import { loadMigrationSql, migrationsDir } from './helpers/migrate';
import { introspectSchema } from './helpers/schema-introspect';

// Baseline-schema guard.
//
// `001_initial_schema.sql` is the single collapsed baseline. The historical
// 001..016 chain was collapsed into it at v1.0; later `002_audit_log_project_scope`
// and the full-text-search change (drop pgvector/embeddings, add `tsvector` columns)
// were folded back into `001` in a second authorized collapse — done while there
// were no deployments to migrate, so an in-place upgrade path was unnecessary.
//
// `test/fixtures/baseline-schema.snapshot.txt` is the introspected schema of that
// baseline. This test asserts `001` still reproduces it, guarding against accidental
// drift. When you intentionally change the baseline, regenerate the fixture IN THE
// SAME COMMIT and review the diff — never edit `001` and leave the fixture stale:
//
//     UPDATE_BASELINE_SNAPSHOT=1 bunx vitest run test/migrate-baseline-schema.test.ts

const FIXTURE = join(migrationsDir(), '..', 'test', 'fixtures', 'baseline-schema.snapshot.txt');

test('collapsed 001 baseline reproduces the captured schema snapshot', async () => {
	const db = await createMemoryDb();
	try {
		await db.exec(loadMigrationSql('001_initial_schema.sql'));
		const actual = await introspectSchema(db);
		if (process.env.UPDATE_BASELINE_SNAPSHOT) {
			writeFileSync(FIXTURE, actual);
			return;
		}
		expect(actual).toBe(readFileSync(FIXTURE, 'utf-8'));
	} finally {
		await db.close();
	}
});
