import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 018_connected_agent_attribution.sql extends audit_actor_type with
// 'connected_agent' and adds parallel connected-agent attribution columns to
// audit_log, task_comments, and document_revisions. This drives the REAL
// migration path against populated data: existing audit rows of every prior
// actor_type must survive the enum swap, and a connected_agent row must work.

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
	'016_connected_agents.sql',
	'017_remove_agent_api_orphans.sql',
];

describe('018 connected-agent attribution migration', () => {
	let db: PGlite;
	let connectedAgentId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });
		for (const file of PRE_MIGRATIONS) await db.exec(loadMigration(file));

		// Pre-migration sanity: the actor column doesn't exist yet.
		const before = await db.query(
			`SELECT 1 FROM information_schema.columns
			 WHERE table_name = 'audit_log' AND column_name = 'actor_connected_agent_id'`,
		);
		expect(before.rows.length).toBe(0);

		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const agent = await db.query<{ id: string }>(
			`INSERT INTO connected_agents (name, prefix, token_hash, status)
			 VALUES ('CRM Bot', 'aaaaaaaa', 'h1', 'approved') RETURNING id`,
		);
		connectedAgentId = agent.rows[0].id;

		// One audit row of each existing actor_type — must survive the enum swap.
		for (const actor of ['admin', 'agent', 'system']) {
			await db.query(
				`INSERT INTO audit_log (team_id, actor_type, actor_member_id, action, entity_type, entity_id)
				 VALUES ($1, $2::audit_actor_type, NULL, 'created', 'task', NULL)`,
				[teamId, actor],
			);
		}

		await db.exec(loadMigration('018_connected_agent_attribution.sql'));
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('extends audit_actor_type with connected_agent and preserves existing rows', async () => {
		const surviving = await db.query<{ actor_type: string }>(
			`SELECT actor_type FROM audit_log ORDER BY actor_type`,
		);
		expect(surviving.rows.map((r) => r.actor_type)).toEqual(['admin', 'agent', 'system']);

		const inserted = await db.query<{ actor_type: string }>(
			`INSERT INTO audit_log (actor_type, actor_connected_agent_id, action, entity_type, entity_id)
			 VALUES ('connected_agent'::audit_actor_type, $1, 'updated', 'task', NULL)
			 RETURNING actor_type`,
			[connectedAgentId],
		);
		expect(inserted.rows[0].actor_type).toBe('connected_agent');
	});

	it('adds nullable connected-agent actor columns to the attributed tables', async () => {
		for (const [table, column] of [
			['audit_log', 'actor_connected_agent_id'],
			['task_comments', 'author_connected_agent_id'],
			['document_revisions', 'author_connected_agent_id'],
		]) {
			const col = await db.query<{ is_nullable: string }>(
				`SELECT is_nullable FROM information_schema.columns
				 WHERE table_name = $1 AND column_name = $2`,
				[table, column],
			);
			expect(col.rows[0]?.is_nullable).toBe('YES');
		}
	});

	it('cascades the FK to NULL when a connected agent is deleted', async () => {
		const team = await db.query<{ id: string }>('SELECT id FROM teams LIMIT 1');
		const agent = await db.query<{ id: string }>(
			`INSERT INTO connected_agents (name, prefix, token_hash, status)
			 VALUES ('Temp Bot', 'bbbbbbbb', 'h2', 'approved') RETURNING id`,
		);
		await db.query(
			`INSERT INTO audit_log (team_id, actor_type, actor_connected_agent_id, action, entity_type, entity_id)
			 VALUES ($1, 'connected_agent'::audit_actor_type, $2, 'updated', 'task', NULL)`,
			[team.rows[0].id, agent.rows[0].id],
		);
		await db.query('DELETE FROM connected_agents WHERE id = $1', [agent.rows[0].id]);
		const row = await db.query<{ actor_connected_agent_id: string | null }>(
			`SELECT actor_connected_agent_id FROM audit_log WHERE actor_connected_agent_id IS NULL AND actor_type = 'connected_agent'`,
		);
		expect(row.rows.length).toBeGreaterThan(0);
	});
});
