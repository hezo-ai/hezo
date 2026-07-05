import { describe, expect, it } from 'vitest';
import { MasterKeyManager } from '../src/crypto/master-key';
import { createMemoryDb } from '../src/db/client';
import type { Db } from '../src/db/database';
import { PostgresDb } from '../src/db/drivers/postgres';
import {
	dumpLogicalBackup,
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
