import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 016_connected_agents.sql adds the `connected_agents` table + `connected_agent_status`
// enum that back external-agent self-registration. This drives the real migration files
// in order (001 -> ... -> 015) against a populated `users` row, then applies 016 and
// asserts the table/enum/FK/unique land and the pre-existing data survives.

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

const PRE_MIGRATIONS = [
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
	'014_comments_embedding.sql',
	'015_heartbeat_run_usage_partial.sql',
];

describe('016_connected_agents migration', () => {
	let db: PGlite;
	let userId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });
		for (const file of PRE_MIGRATIONS) await db.exec(loadMigration(file));

		// Pre-migration: connected_agents does not exist yet.
		const before = await db.query(
			`SELECT 1 FROM information_schema.tables WHERE table_name = 'connected_agents'`,
		);
		expect(before.rows.length).toBe(0);

		const user = await db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Admin', true) RETURNING id`,
		);
		userId = user.rows[0].id;

		await db.exec(loadMigration('016_connected_agents.sql'));
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('creates the table and status enum', async () => {
		const table = await db.query(
			`SELECT 1 FROM information_schema.tables WHERE table_name = 'connected_agents'`,
		);
		expect(table.rows.length).toBe(1);
		const enumType = await db.query(
			`SELECT 1 FROM pg_type WHERE typname = 'connected_agent_status'`,
		);
		expect(enumType.rows.length).toBe(1);
	});

	it('preserves the pre-existing user and supports the full lifecycle', async () => {
		const stillThere = await db.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
		expect(stillThere.rows.length).toBe(1);

		const inserted = await db.query<{ id: string; status: string }>(
			`INSERT INTO connected_agents (name, prefix, token_hash)
			 VALUES ('bot', 'abcd1234', 'hash') RETURNING id, status`,
		);
		expect(inserted.rows[0].status).toBe('pending');

		// Approve: enum accepts 'approved' and the FK to users resolves.
		await db.query(
			`UPDATE connected_agents SET status = 'approved', approved_at = now(), approved_by_user_id = $2 WHERE id = $1`,
			[inserted.rows[0].id, userId],
		);
		const approved = await db.query<{ status: string; approved_by_user_id: string }>(
			`SELECT status, approved_by_user_id FROM connected_agents WHERE id = $1`,
			[inserted.rows[0].id],
		);
		expect(approved.rows[0].status).toBe('approved');
		expect(approved.rows[0].approved_by_user_id).toBe(userId);
	});

	it('enforces the unique prefix', async () => {
		await expect(
			db.query(
				`INSERT INTO connected_agents (name, prefix, token_hash) VALUES ('dup', 'abcd1234', 'h2')`,
			),
		).rejects.toThrow();
	});
});
