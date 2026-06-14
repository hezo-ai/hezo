import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 007_comment_public_id.sql adds a human-friendly `public_id` slug to every task
// comment (the creation timestamp `YYYYMMDDHH24MISS` in UTC, with a `-N` suffix
// when several comments on one task share a second) and a BEFORE INSERT trigger
// that auto-assigns it. This drives the REAL migration files through the same
// apply-in-order path production uses (001 -> ... -> 007) against populated
// comments, asserting the backfill, the per-task collision handling, that
// existing rows + child FKs survive, and that the trigger fires on new inserts.

function migrationsDir(): string {
	try {
		return fileURLToPath(new URL('../migrations', import.meta.url));
	} catch {
		const override = process.env.HEZO_MIGRATIONS_DIR;
		if (!override) throw new Error('HEZO_MIGRATIONS_DIR unset and import.meta.url not a file URL');
		return override;
	}
}

function loadMigration(file: string): string {
	// PGlite loads pgcrypto built-in; strip only that, keep vector.
	return readFileSync(join(migrationsDir(), file), 'utf-8').replace(
		/CREATE EXTENSION IF NOT EXISTS "pgcrypto";/g,
		'',
	);
}

const PRE_PUBLIC_ID_MIGRATIONS = [
	'001_initial_schema.sql',
	'002_migration_smoke.sql',
	'003_budgeting.sql',
	'004_cost_provider_tracking.sql',
	'005_model_pricing.sql',
	'006_budget_runtime_states.sql',
];

// 2026-10-09 11:23:45 UTC -> base slug for the collision fixtures.
const SAME_SECOND = '2026-10-09 11:23:45+00';
const BASE = '20261009112345';

describe('007_comment_public_id migration', () => {
	let db: PGlite;
	let taskAId: string;
	let taskBId: string;
	let memberId: string;
	// The two same-second comments on task A (we can't predict which UUID sorts
	// first, so we assert on the set of slugs, not per-row).
	let collidingIds: string[];
	let otherSecondId: string;
	let taskBCommentId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });
		for (const file of PRE_PUBLIC_ID_MIGRATIONS) await db.exec(loadMigration(file));

		// Pre-migration: public_id does not exist yet.
		const before = await db.query(
			`SELECT 1 FROM information_schema.columns
			 WHERE table_name = 'task_comments' AND column_name = 'public_id'`,
		);
		expect(before.rows.length).toBe(0);

		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Ops', 'ops', 'OPS') RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'user', 'Admin') RETURNING id`,
			[teamId],
		);
		memberId = member.rows[0].id;

		const taskA = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'OPS-1', 'Task A') RETURNING id`,
			[teamId, projectId],
		);
		taskAId = taskA.rows[0].id;
		const taskB = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 2, 'OPS-2', 'Task B') RETURNING id`,
			[teamId, projectId],
		);
		taskBId = taskB.rows[0].id;

		async function insertComment(taskId: string, createdAt: string, text: string): Promise<string> {
			const r = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content, created_at)
				 VALUES ($1, $2, $3::jsonb, $4::timestamptz) RETURNING id`,
				[taskId, memberId, JSON.stringify({ text }), createdAt],
			);
			return r.rows[0].id;
		}

		// Two comments on task A in the SAME second -> must disambiguate.
		collidingIds = [
			await insertComment(taskAId, SAME_SECOND, 'first in second'),
			await insertComment(taskAId, SAME_SECOND, 'second in second'),
		];
		// A comment on task A in a DIFFERENT second.
		otherSecondId = await insertComment(taskAId, '2026-10-09 11:24:00+00', 'a minute later');
		// A comment on task B in the SAME wall-clock second as task A's pair: the
		// collision scope is per-task, so this one keeps the bare base slug.
		taskBCommentId = await insertComment(taskBId, SAME_SECOND, 'task B, same second');

		// A child row whose FK targets the comment UUID — must survive untouched.
		await db.query(
			`INSERT INTO comment_reactions (comment_id, member_id, kind) VALUES ($1, $2, 'thumbs_up')`,
			[otherSecondId, memberId],
		);

		// The actual upgrade step.
		await db.exec(loadMigration('007_comment_public_id.sql'));
	});

	it('adds a NOT NULL public_id column with a per-task unique index', async () => {
		const col = await db.query<{ is_nullable: string }>(
			`SELECT is_nullable FROM information_schema.columns
			 WHERE table_name = 'task_comments' AND column_name = 'public_id'`,
		);
		expect(col.rows[0]?.is_nullable).toBe('NO');

		const idx = await db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_comments_public_id'`,
		);
		expect(idx.rows.length).toBe(1);
	});

	it('backfills every comment with a timestamp slug', async () => {
		const r = await db.query<{ public_id: string }>(`SELECT public_id FROM task_comments`);
		expect(r.rows.length).toBe(4);
		for (const row of r.rows) {
			expect(row.public_id).toMatch(/^\d{14}(-\d+)?$/);
		}
	});

	it('disambiguates same-second comments within a task with a -N suffix', async () => {
		const r = await db.query<{ public_id: string }>(
			`SELECT public_id FROM task_comments WHERE id = ANY($1::uuid[]) ORDER BY public_id`,
			[collidingIds],
		);
		expect(r.rows.map((x) => x.public_id)).toEqual([BASE, `${BASE}-2`]);
	});

	it('scopes collisions per task — task B keeps the bare base slug', async () => {
		const r = await db.query<{ public_id: string }>(
			`SELECT public_id FROM task_comments WHERE id = $1`,
			[taskBCommentId],
		);
		expect(r.rows[0].public_id).toBe(BASE);
	});

	it('derives the slug from the comment created_at', async () => {
		const r = await db.query<{ public_id: string }>(
			`SELECT public_id FROM task_comments WHERE id = $1`,
			[otherSecondId],
		);
		expect(r.rows[0].public_id).toBe('20261009112400');
	});

	it('preserves existing comment data and child FKs', async () => {
		const r = await db.query<{ id: string; text: string }>(
			`SELECT id, content->>'text' AS text FROM task_comments WHERE id = $1`,
			[otherSecondId],
		);
		expect(r.rows[0].text).toBe('a minute later');
		// The reaction still resolves to the same comment UUID (id is untouched).
		const reaction = await db.query<{ comment_id: string }>(
			`SELECT comment_id FROM comment_reactions WHERE comment_id = $1`,
			[otherSecondId],
		);
		expect(reaction.rows[0]?.comment_id).toBe(otherSecondId);
	});

	it('auto-assigns public_id on new inserts via the trigger', async () => {
		// Same second as the pre-existing pair (base, base-2) on task A -> base-3.
		const collide = await db.query<{ public_id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content, created_at)
			 VALUES ($1, $2, $3::jsonb, $4::timestamptz) RETURNING public_id`,
			[taskAId, memberId, JSON.stringify({ text: 'third in second' }), SAME_SECOND],
		);
		expect(collide.rows[0].public_id).toBe(`${BASE}-3`);

		// A fresh second gets the bare slug.
		const fresh = await db.query<{ public_id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content, created_at)
			 VALUES ($1, $2, $3::jsonb, '2026-10-09 13:00:00+00'::timestamptz) RETURNING public_id`,
			[taskAId, memberId, JSON.stringify({ text: 'much later' })],
		);
		expect(fresh.rows[0].public_id).toBe('20261009130000');

		// An insert that doesn't set created_at still gets a well-formed slug.
		const defaulted = await db.query<{ public_id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content)
			 VALUES ($1, $2, $3::jsonb) RETURNING public_id`,
			[taskBId, memberId, JSON.stringify({ text: 'now' })],
		);
		expect(defaulted.rows[0].public_id).toMatch(/^\d{14}(-\d+)?$/);
	});

	it('cleans up', async () => {
		await safeClose(db);
	});
});
