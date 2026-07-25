import { describe, expect, it } from 'vitest';
import { MasterKeyManager } from '../src/crypto/master-key';
import { createMemoryDb } from '../src/db/client';
import type { Db, Queryable } from '../src/db/database';
import { PostgresDb } from '../src/db/drivers/postgres';
import {
	dumpLogicalBackup,
	dumpPageRows,
	planInsertBatches,
	readLogicalBackupHeader,
	restoreLogicalBackup,
} from '../src/db/logical-backup';
import { BackupNewerThanAppError, RestorePreconditionError } from '../src/db/migrate-errors';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';
import { allMigrations } from './helpers/migrate';
import { createScratchPostgres } from './helpers/scratch-postgres';

// The portable logical backup is the operator backup format for BOTH storage
// backends, and the migration path BETWEEN them (embedded → hosted Postgres
// and back). The PGlite leg proves the format round-trips a real, seeded
// instance; the env-gated cross-backend legs in CI prove the same bytes load
// onto real Postgres.

async function seedRichData(db: Db): Promise<{ teamId: string; taskId: string }> {
	const team = await db.query<{ id: string }>(`SELECT id FROM teams ORDER BY created_at LIMIT 1`);
	const teamId = team.rows[0].id;
	const project = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE team_id = $1 LIMIT 1`,
		[teamId],
	);
	const projectId = project.rows[0].id;

	const parent = await db.query<{ id: string }>(
		`INSERT INTO tasks (project_id, team_id, number, identifier, title, description)
		 VALUES ($1, $2, 9001, 'BKP-9001', 'Parent: unicode ✓ and ''quotes''', 'searchable haystack needle')
		 RETURNING id`,
		[projectId, teamId],
	);
	// Self-referencing FK — the restore must not care about insert order.
	await db.query(
		`INSERT INTO tasks (project_id, team_id, number, identifier, title, parent_task_id)
		 VALUES ($1, $2, 9002, 'BKP-9002', 'Child of 9001', $3)`,
		[projectId, teamId, parent.rows[0].id],
	);
	// bytea round-trip.
	await db.query(
		`INSERT INTO project_icons (project_id, content_type, data, byte_size, width, height)
		 VALUES ($1, 'image/png', $2, 6, 1, 1)`,
		[projectId, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])],
	);
	return { teamId, taskId: parent.rows[0].id };
}

describe('byte-aware batch sizing', () => {
	it('sizes dump pages from average row size, clamped to [1, flat cap]', () => {
		// Empty table: nothing to size, keep the flat cap.
		expect(dumpPageRows({ rowCount: 0, totalBytes: 0, maxRowBytes: 0 })).toBe(5000);
		// Tiny rows: the flat row cap keeps a single response bounded.
		expect(dumpPageRows({ rowCount: 100_000, totalBytes: 1_000_000, maxRowBytes: 50 })).toBe(5000);
		// ~300KB average rows fit ~13 to a 4MB page.
		expect(dumpPageRows({ rowCount: 30, totalBytes: 9_000_000, maxRowBytes: 310_000 })).toBe(
			Math.floor((4 * 1024 * 1024) / 300_000),
		);
		// Average at/above the byte target: one row at a time.
		expect(dumpPageRows({ rowCount: 2, totalBytes: 8_000_000, maxRowBytes: 4_000_000 })).toBe(1);
		// A single outlier row past the target forces row-at-a-time even when
		// the average looks harmless.
		expect(dumpPageRows({ rowCount: 1000, totalBytes: 10_000_000, maxRowBytes: 9_000_000 })).toBe(
			1,
		);
	});

	it('splits insert batches on row cap and cumulative byte target', () => {
		expect(planInsertBatches([])).toEqual([]);
		// Row cap.
		expect(planInsertBatches([1, 1, 1, 1, 1], 2, 1000)).toEqual([
			{ start: 0, end: 2 },
			{ start: 2, end: 4 },
			{ start: 4, end: 5 },
		]);
		// Byte target: a row that would push past it starts the next batch.
		expect(planInsertBatches([3, 3, 3], 500, 4)).toEqual([
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
			{ start: 2, end: 3 },
		]);
		expect(planInsertBatches([1, 1, 1, 1, 1], 500, 4)).toEqual([
			{ start: 0, end: 4 },
			{ start: 4, end: 5 },
		]);
		// A single oversized row still gets its own batch.
		expect(planInsertBatches([100], 500, 4)).toEqual([{ start: 0, end: 1 }]);
	});
});

/** Wrap a Db so every SQL statement (incl. inside transactions) is recorded. */
function recordingDb(inner: Db): { db: Db; queries: string[] } {
	const queries: string[] = [];
	const wrapQueryable = <Q extends Queryable>(q: Q): Q =>
		new Proxy(q, {
			get(target, prop, receiver) {
				if (prop === 'query' || prop === 'exec') {
					return (sql: string, params?: unknown[]) => {
						queries.push(sql);
						return prop === 'query' ? target.query(sql, params) : target.exec(sql);
					};
				}
				if (prop === 'transaction') {
					return (cb: (tx: Queryable) => Promise<unknown>) =>
						(target as unknown as Db).transaction((tx) => cb(wrapQueryable(tx)));
				}
				return Reflect.get(target, prop, receiver);
			},
		});
	return { db: wrapQueryable(inner), queries };
}

describe('logical backup round-trip (PGlite leg)', () => {
	it('dumps a seeded instance and restores it losslessly onto a fresh database', async () => {
		const ctx = await createTestApp();
		const migrations = allMigrations();
		try {
			await seedRichData(ctx.db);
			const bytes = await dumpLogicalBackup(ctx.db, { hezoVersion: 'test', migrations });

			const header = readLogicalBackupHeader(bytes);
			expect(header?.formatVersion).toBe(1);
			expect(header?.migrations.length).toBeGreaterThan(0);

			const restored = await createMemoryDb();
			try {
				const summary = await restoreLogicalBackup(restored, bytes, migrations);
				expect(summary.rows).toBeGreaterThan(0);

				// Row parity across representative tables (incl. seeded builtins).
				for (const table of ['users', 'teams', 'member_agents', 'tasks', 'system_meta']) {
					const [a, b] = await Promise.all([
						ctx.db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table}`),
						restored.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table}`),
					]);
					expect(b.rows[0].c, `row count for ${table}`).toBe(a.rows[0].c);
				}

				// Content + self-FK survived.
				const child = await restored.query<{ parent_task_id: string; title: string }>(
					`SELECT parent_task_id, title FROM tasks WHERE identifier = 'BKP-9002'`,
				);
				expect(child.rows[0].title).toBe('Child of 9001');

				// bytea round-trip is byte-exact.
				const icon = await restored.query<{ data: Uint8Array }>(
					`SELECT data FROM project_icons LIMIT 1`,
				);
				expect(Array.from(icon.rows[0].data)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

				// Generated tsvector columns were excluded from the dump and
				// recomputed on load — full-text search works on the restored DB.
				const fts = await restored.query<{ identifier: string }>(
					`SELECT identifier FROM tasks WHERE search_tsv @@ to_tsquery('english', 'needle')`,
				);
				expect(fts.rows.map((r) => r.identifier)).toEqual(['BKP-9001']);

				// FKs were re-added: an orphan insert must fail again.
				await expect(
					restored.query(
						`INSERT INTO tasks (project_id, team_id, number, identifier, title)
						 VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'X-1', 'orphan')`,
					),
				).rejects.toThrow();

				// The serial _migrations bookkeeping was replayed, and serial
				// sequences resume: recording a new row must not collide.
				await restored.query(
					`INSERT INTO _migrations (filename, checksum) VALUES ('zzz_probe.sql', 'x')`,
				);

				// The vault travels: the same unlock key unlocks the restored DB.
				const mkm = new MasterKeyManager();
				expect(await mkm.initialize(restored, ctx.unlockKeyHex)).toBe('unlocked');
			} finally {
				await restored.close();
			}
		} finally {
			await safeClose(ctx.db);
		}
	});

	it('pages a large-log table by bytes on dump and byte-caps restore inserts', async () => {
		const ctx = await createTestApp();
		const migrations = allMigrations();
		try {
			// ~9MB of log chunks across 30 runs — far past one 4MB page, so a flat
			// row-count page would return it all in one response (the shape that
			// crashes embedded PGlite's WASM on real instances).
			const member = await ctx.db.query<{ id: string; team_id: string }>(
				`SELECT id, team_id FROM members LIMIT 1`,
			);
			await ctx.db.query(
				`WITH new_runs AS (
				   INSERT INTO heartbeat_runs (team_id, member_id, status)
				   SELECT $1, $2, 'succeeded' FROM generate_series(1, 30) n
				   RETURNING id
				 )
				 INSERT INTO heartbeat_run_log_chunks (run_id, seq, content)
				 SELECT id, 0, repeat('x', 300000) || id::text FROM new_runs`,
				[member.rows[0].team_id, member.rows[0].id],
			);

			const source = recordingDb(ctx.db);
			const bytes = await dumpLogicalBackup(source.db, { hezoVersion: 'test', migrations });
			const pageSelects = source.queries.filter(
				(q) => q.includes('FROM "heartbeat_run_log_chunks"') && q.includes('LIMIT'),
			);
			expect(pageSelects.length).toBeGreaterThanOrEqual(3);
			// Every page carries the byte-derived row limit, not the flat cap.
			for (const q of pageSelects) expect(q).not.toContain('LIMIT 5000');

			const restored = await createMemoryDb();
			try {
				const target = recordingDb(restored);
				await restoreLogicalBackup(target.db, bytes, migrations);
				const inserts = target.queries.filter((q) =>
					q.startsWith('INSERT INTO "heartbeat_run_log_chunks"'),
				);
				expect(inserts.length).toBeGreaterThanOrEqual(3);

				// The paged dump + batched restore is lossless.
				const [a, b] = await Promise.all([
					ctx.db.query<{ n: number; len: string }>(
						`SELECT COUNT(*)::int AS n, COALESCE(SUM(length(content)), 0)::text AS len
						 FROM heartbeat_run_log_chunks`,
					),
					restored.query<{ n: number; len: string }>(
						`SELECT COUNT(*)::int AS n, COALESCE(SUM(length(content)), 0)::text AS len
						 FROM heartbeat_run_log_chunks`,
					),
				]);
				expect(b.rows[0]).toEqual(a.rows[0]);
			} finally {
				await restored.close();
			}
		} finally {
			await safeClose(ctx.db);
		}
	});

	it('refuses a non-empty target without wipe, restores over it with wipe', async () => {
		const ctx = await createTestApp();
		const migrations = allMigrations();
		try {
			const bytes = await dumpLogicalBackup(ctx.db, { hezoVersion: 'test', migrations });

			const occupied = await createMemoryDb();
			try {
				await occupied.exec('CREATE TABLE already_here (id INT)');
				await expect(restoreLogicalBackup(occupied, bytes, migrations)).rejects.toBeInstanceOf(
					RestorePreconditionError,
				);

				await restoreLogicalBackup(occupied, bytes, migrations, { wipe: true });
				const teams = await occupied.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM teams');
				expect(teams.rows[0].c).toBeGreaterThan(0);
				// The pre-existing table went with the wiped schema.
				await expect(occupied.query('SELECT 1 FROM already_here')).rejects.toThrow();
			} finally {
				await occupied.close();
			}
		} finally {
			await safeClose(ctx.db);
		}
	});

	it('refuses a backup recorded by a newer Hezo', async () => {
		const ctx = await createTestApp();
		const migrations = allMigrations();
		try {
			await ctx.db.query(
				`INSERT INTO _migrations (filename, checksum) VALUES ('999_from_the_future.sql', 'x')`,
			);
			const bytes = await dumpLogicalBackup(ctx.db, { hezoVersion: 'future', migrations });
			const restored = await createMemoryDb();
			try {
				await expect(restoreLogicalBackup(restored, bytes, migrations)).rejects.toBeInstanceOf(
					BackupNewerThanAppError,
				);
			} finally {
				await restored.close();
			}
		} finally {
			await safeClose(ctx.db);
		}
	});
});

// Env-gated: the backend-move story, both directions, against real Postgres.
describe.skipIf(!process.env.HEZO_TEST_DATABASE_URL)('logical backup cross-backend moves', () => {
	it('moves an instance embedded → Postgres → embedded with data and vault intact', async () => {
		const ctx = await createTestApp();
		const migrations = allMigrations();
		const scratch = await createScratchPostgres('move');
		const external = await PostgresDb.connect({ url: scratch.url });
		try {
			await seedRichData(ctx.db);

			// Embedded → Postgres.
			const outbound = await dumpLogicalBackup(ctx.db, { hezoVersion: 'test', migrations });
			await restoreLogicalBackup(external, outbound, migrations, { wipe: true });

			const child = await external.query<{ title: string }>(
				`SELECT title FROM tasks WHERE identifier = 'BKP-9002'`,
			);
			expect(child.rows[0].title).toBe('Child of 9001');
			const fts = await external.query<{ identifier: string }>(
				`SELECT identifier FROM tasks WHERE search_tsv @@ to_tsquery('english', 'needle')`,
			);
			expect(fts.rows.map((r) => r.identifier)).toEqual(['BKP-9001']);
			const icon = await external.query<{ data: Uint8Array }>(
				`SELECT data FROM project_icons LIMIT 1`,
			);
			expect(Array.from(icon.rows[0].data)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
			const mkmExternal = new MasterKeyManager();
			expect(await mkmExternal.initialize(external, ctx.unlockKeyHex)).toBe('unlocked');

			// …and back: Postgres → embedded.
			const inbound = await dumpLogicalBackup(external, { hezoVersion: 'test', migrations });
			const homeAgain = await createMemoryDb();
			try {
				await restoreLogicalBackup(homeAgain, inbound, migrations);
				for (const table of ['users', 'teams', 'tasks', 'system_meta']) {
					const [a, b] = await Promise.all([
						ctx.db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table}`),
						homeAgain.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table}`),
					]);
					expect(b.rows[0].c, `row count for ${table}`).toBe(a.rows[0].c);
				}
				const mkmHome = new MasterKeyManager();
				expect(await mkmHome.initialize(homeAgain, ctx.unlockKeyHex)).toBe('unlocked');
			} finally {
				await homeAgain.close();
			}
		} finally {
			await external.close();
			await scratch.drop();
			await safeClose(ctx.db);
		}
	});
});
