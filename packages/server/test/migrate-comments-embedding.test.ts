import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 014_comments_embedding.sql adds an `embedding vector(384)` column + HNSW cosine
// index to task_comments (mirroring tasks/documents/skills) so text comments can
// be semantically searched. This drives the real migration files through the
// apply-in-order path (001 -> ... -> 014) against a populated comment, asserting
// the column/index land and existing rows survive with a NULL embedding.

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
	return readFileSync(join(migrationsDir(), file), 'utf-8').replace(
		/CREATE EXTENSION IF NOT EXISTS "pgcrypto";/g,
		'',
	);
}

const PRE_EMBEDDING_MIGRATIONS = [
	'001_initial_schema.sql',
	'002_migration_smoke.sql',
	'003_budgeting.sql',
	'004_cost_provider_tracking.sql',
	'005_model_pricing.sql',
	'006_budget_runtime_states.sql',
	'007_comment_public_id.sql',
	'008_opencode_kimi_runtimes.sql',
	'009_skills_builtin.sql',
	'010_heartbeat_run_produced_output.sql',
	'011_heartbeat_run_no_work.sql',
	'012_drop_skills_builtin.sql',
	'013_remove_options_comment.sql',
];

describe('014_comments_embedding migration', () => {
	let db: PGlite;
	let commentId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });
		for (const file of PRE_EMBEDDING_MIGRATIONS) await db.exec(loadMigration(file));

		// Pre-migration: task_comments.embedding does not exist yet.
		const before = await db.query(
			`SELECT 1 FROM information_schema.columns
			 WHERE table_name = 'task_comments' AND column_name = 'embedding'`,
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
		const task = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'OPS-1', 'Seed task') RETURNING id`,
			[teamId, project.rows[0].id],
		);
		const comment = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'text', $2::jsonb) RETURNING id`,
			[task.rows[0].id, JSON.stringify({ text: 'pre-existing comment' })],
		);
		commentId = comment.rows[0].id;

		// The actual upgrade step.
		await db.exec(loadMigration('014_comments_embedding.sql'));
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('adds the embedding column', async () => {
		const col = await db.query(
			`SELECT 1 FROM information_schema.columns
			 WHERE table_name = 'task_comments' AND column_name = 'embedding'`,
		);
		expect(col.rows.length).toBe(1);
	});

	it('creates the hnsw cosine index', async () => {
		const idx = await db.query(
			`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_comments_embedding'`,
		);
		expect(idx.rows.length).toBe(1);
	});

	it('preserves existing comments with a null embedding', async () => {
		const row = await db.query<{ embedding: unknown }>(
			`SELECT embedding FROM task_comments WHERE id = $1`,
			[commentId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].embedding).toBeNull();
	});

	it('stores a 384-d embedding vector after migration', async () => {
		const vec = `[${Array.from({ length: 384 }, () => 0.1).join(',')}]`;
		await db.query(`UPDATE task_comments SET embedding = $1::vector WHERE id = $2`, [
			vec,
			commentId,
		]);
		const row = await db.query<{ embedding: unknown }>(
			`SELECT embedding FROM task_comments WHERE id = $1`,
			[commentId],
		);
		expect(row.rows[0].embedding).not.toBeNull();
	});
});
