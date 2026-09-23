import { RunLogRewriteFailureReason } from '@hezo/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { PostgresDb } from '../src/db/drivers/postgres';
import { applyPendingMigrationsExternal } from '../src/db/migrate-external';
import { estimateRunLogFreeBytes, rewriteRunLogTables } from '../src/services/log-compaction';
import { safeClose } from './helpers';
import { createTestDbWithMigrations } from './helpers/db';
import { allMigrations } from './helpers/migrate';
import { createScratchPostgres } from './helpers/scratch-postgres';

/**
 * Rewriting the run-log tables, and the free-space estimate that says what a
 * rewrite would return, on both drivers. The PGlite leg always runs; the
 * postgres leg runs when `HEZO_TEST_DATABASE_URL` points at a real Postgres
 * (the `test-postgres` CI job provides one). Only the postgres leg can hold a
 * table from a second session or connect as a second role, so the busy and
 * not-owner cases run there alone.
 */
interface DriverCase {
	name: string;
	available: boolean;
	create(): Promise<{ db: Db; url: string | null; cleanup(): Promise<void> }>;
}

const drivers: DriverCase[] = [
	{
		name: 'pglite',
		available: true,
		create: async () => {
			const db = await createTestDbWithMigrations();
			return { db, url: null, cleanup: () => safeClose(db) };
		},
	},
	{
		name: 'postgres',
		available: Boolean(process.env.HEZO_TEST_DATABASE_URL),
		create: async () => {
			const scratch = await createScratchPostgres('rewrite');
			const db = await PostgresDb.connect({ url: scratch.url });
			await applyPendingMigrationsExternal(db, allMigrations());
			return {
				db,
				url: scratch.url,
				cleanup: async () => {
					await db.close();
					await scratch.drop();
				},
			};
		},
	},
];

const RUN_LOG_TABLES = ['heartbeat_run_log_chunks', 'heartbeat_runs'];

async function tableBytes(db: Db): Promise<number> {
	const r = await db.query<{ b: number }>(
		`SELECT (pg_table_size('heartbeat_run_log_chunks') + pg_table_size('heartbeat_runs'))::bigint AS b`,
	);
	return Number(r.rows[0].b);
}

async function fileNode(db: Db, table: string): Promise<number> {
	const r = await db.query<{ n: number }>(
		'SELECT pg_relation_filenode($1::regclass)::bigint AS n',
		[table],
	);
	return Number(r.rows[0].n);
}

/**
 * Runs whose logs are streamed in chunks of a few hundred bytes to a few KB,
 * shaped like agent output, so each one mixes rows stored in line with rows
 * moved to TOAST.
 */
async function seedStreamedRuns(db: Db, runs: number, chunksPerRun: number): Promise<string> {
	const slug = `rewrite-${Math.random().toString(36).slice(2, 10)}`;
	const team = await db.query<{ id: string }>(
		`INSERT INTO teams (name, slug) VALUES ('Rewrite', $1) RETURNING id`,
		[slug],
	);
	const teamId = team.rows[0].id;
	const member = await db.query<{ id: string }>(
		`INSERT INTO members (team_id, member_type, display_name)
		 VALUES ($1, 'agent', 'Worker') RETURNING id`,
		[teamId],
	);
	await db.query(
		`INSERT INTO heartbeat_runs (team_id, member_id, status, created_at)
		 SELECT $1, $2, 'succeeded'::heartbeat_run_status, now() - interval '60 days'
		 FROM generate_series(1, $3)`,
		[teamId, member.rows[0].id, runs],
	);
	await db.query(
		`INSERT INTO heartbeat_run_log_chunks (run_id, seq, content)
		 SELECT hr.id, s.n,
		        (SELECT string_agg(format('[%s] tool_call read_file path=/workspace/src/%s.ts result=%s',
		                                  i, substr(md5(random()::text), 1, 6), md5(random()::text)), E'\\n')
		         FROM generate_series(1, 4 + (s.n * 7 + ascii(hr.id::text)) % 60) i)
		 FROM heartbeat_runs hr, generate_series(0, $2 - 1) AS s(n)
		 WHERE hr.team_id = $1`,
		[teamId, chunksPerRun],
	);
	return teamId;
}

describe.each(drivers.filter((d) => d.available))('run-log table rewrite: $name', (driver) => {
	let db: Db;
	let url: string | null;
	let cleanup: () => Promise<void>;

	beforeAll(async () => {
		({ db, url, cleanup } = await driver.create());
	});

	afterAll(async () => {
		await cleanup();
	});

	it('the free-space estimate tracks what a rewrite returns', async () => {
		const teamId = await seedStreamedRuns(db, 300, 30);

		// A freshly rewritten table has no free space, and the estimate must not
		// invent any.
		const first = await rewriteRunLogTables(db, { retryMs: 0 });
		expect(first.failure).toBeNull();
		expect(await estimateRunLogFreeBytes(db)).toBe(0);

		// Compaction-shaped churn: two thirds of the runs lose their streamed
		// chunks for one ~12 KB compacted chunk each. The plain VACUUM is what
		// autovacuum would do: the space becomes reusable, the files keep their size.
		await db.query(
			`WITH compacted AS (
			   SELECT id FROM heartbeat_runs WHERE team_id = $1 ORDER BY id LIMIT 200
			 ), dropped AS (
			   DELETE FROM heartbeat_run_log_chunks WHERE run_id IN (SELECT id FROM compacted)
			 )
			 INSERT INTO heartbeat_run_log_chunks (run_id, seq, content)
			 SELECT c.id, 1000,
			        (SELECT string_agg(md5(random()::text), ' ') FROM generate_series(1, 370)
			         WHERE c.id IS NOT NULL)
			 FROM compacted c`,
			[teamId],
		);
		for (const table of RUN_LOG_TABLES) await db.query(`VACUUM ${table}`);

		const before = await tableBytes(db);
		const estimate = await estimateRunLogFreeBytes(db);
		const files = [await fileNode(db, RUN_LOG_TABLES[0]), await fileNode(db, RUN_LOG_TABLES[1])];

		const rewrite = await rewriteRunLogTables(db, { retryMs: 0 });

		expect(rewrite.failure).toBeNull();
		const returned = before - (await tableBytes(db));
		expect(estimate).toBeGreaterThan(0);
		expect(Math.abs(estimate - returned)).toBeLessThan(before * 0.1);
		// The reported figure also counts the indexes the rewrite rebuilt.
		expect(rewrite.diskBytesFreed).toBeGreaterThanOrEqual(returned);
		expect(await fileNode(db, RUN_LOG_TABLES[0])).not.toBe(files[0]);
		expect(await fileNode(db, RUN_LOG_TABLES[1])).not.toBe(files[1]);
		expect(await estimateRunLogFreeBytes(db)).toBe(0);
	});

	it.runIf(driver.name === 'postgres')(
		'a table another session holds is reported busy, not rewritten',
		async () => {
			const holder = new pg.Client({ connectionString: url ?? '' });
			await holder.connect();
			try {
				await holder.query('BEGIN');
				await holder.query('LOCK TABLE heartbeat_run_log_chunks IN ACCESS SHARE MODE');
				const file = await fileNode(db, 'heartbeat_run_log_chunks');

				const rewrite = await rewriteRunLogTables(db, { retryMs: 0 });

				expect(rewrite.failure).toEqual({
					reason: RunLogRewriteFailureReason.Busy,
					table: 'heartbeat_run_log_chunks',
					message: null,
				});
				expect(await fileNode(db, 'heartbeat_run_log_chunks')).toBe(file);
			} finally {
				await holder.query('ROLLBACK');
				await holder.end();
			}
		},
	);

	it.runIf(driver.name === 'postgres')(
		'a table the connecting user does not own is reported as such, not as busy',
		async () => {
			// Postgres skips a table the user may not vacuum with only a warning,
			// exactly as it skips a busy one.
			const role = `hezo_not_owner_${Math.random().toString(36).slice(2, 10)}`;
			await db.query(`CREATE ROLE ${role} LOGIN PASSWORD 'not-owner'`);
			const asRole = new URL(url ?? '');
			asRole.username = role;
			asRole.password = 'not-owner';
			const notOwner = await PostgresDb.connect({ url: asRole.toString() });
			try {
				const rewrite = await rewriteRunLogTables(notOwner, { retryMs: 0 });

				expect(rewrite.failure).toEqual({
					reason: RunLogRewriteFailureReason.NotOwner,
					table: 'heartbeat_run_log_chunks',
					message: null,
				});
			} finally {
				await notOwner.close();
				await db.query(`DROP OWNED BY ${role}`);
				await db.query(`DROP ROLE ${role}`);
			}
		},
	);
});
