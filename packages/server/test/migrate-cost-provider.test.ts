import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 004_cost_provider_tracking.sql drops the team dimension from cost_entries
// (cost is project/agent/adapter-scoped now) and adds AI-adapter attribution
// (ai_provider_config_id + provider snapshot) to cost_entries and heartbeat_runs.
// This drives the REAL migration files through the apply-in-order path
// (001 -> 002 -> 003 -> 004) against populated data, asserting both the schema
// delta and that existing cost rows survive with their project attribution.

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

async function columnExists(db: PGlite, table: string, column: string): Promise<boolean> {
	const r = await db.query(
		`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
		[table, column],
	);
	return r.rows.length > 0;
}

describe('004_cost_provider_tracking migration', () => {
	let db: PGlite;
	let costId: string;
	let projectId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });

		// Apply the schema up to (but not including) 004 — the pre-004 shape still
		// has cost_entries.team_id, so we can populate with it.
		await db.exec(loadMigration('001_initial_schema.sql'));
		await db.exec(loadMigration('002_migration_smoke.sql'));
		await db.exec(loadMigration('003_budgeting.sql'));

		expect(await columnExists(db, 'cost_entries', 'team_id')).toBe(true);
		expect(await columnExists(db, 'cost_entries', 'ai_provider_config_id')).toBe(false);

		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', 'Bot') RETURNING id`,
			[teamId],
		);
		const agentId = member.rows[0].id;
		await db.query(`INSERT INTO member_agents (id, title, slug) VALUES ($1, 'Bot', 'bot')`, [
			agentId,
		]);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Ops', 'ops', 'OPS') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const cost = await db.query<{ id: string }>(
			`INSERT INTO cost_entries (team_id, member_id, project_id, amount_cents, description)
			 VALUES ($1, $2, $3, 1234, 'a run') RETURNING id`,
			[teamId, agentId, projectId],
		);
		costId = cost.rows[0].id;

		// The actual upgrade step.
		await db.exec(loadMigration('004_cost_provider_tracking.sql'));
	});

	it('drops the team dimension from cost_entries', async () => {
		expect(await columnExists(db, 'cost_entries', 'team_id')).toBe(false);
		const r = await db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_costs_team'`,
		);
		expect(r.rows.length).toBe(0);
	});

	it('adds adapter attribution to cost_entries and heartbeat_runs', async () => {
		expect(await columnExists(db, 'cost_entries', 'ai_provider_config_id')).toBe(true);
		expect(await columnExists(db, 'cost_entries', 'provider')).toBe(true);
		expect(await columnExists(db, 'heartbeat_runs', 'ai_provider_config_id')).toBe(true);
		expect(await columnExists(db, 'heartbeat_runs', 'provider')).toBe(true);
		const idx = await db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_costs_provider_config'`,
		);
		expect(idx.rows.length).toBe(1);
	});

	it('preserves existing cost rows with NULL adapter attribution', async () => {
		const cost = await db.query<{
			amount_cents: number;
			project_id: string;
			ai_provider_config_id: string | null;
			provider: string | null;
		}>(
			`SELECT amount_cents, project_id, ai_provider_config_id, provider
			 FROM cost_entries WHERE id = $1`,
			[costId],
		);
		expect(cost.rows[0]).toEqual({
			amount_cents: 1234,
			project_id: projectId,
			ai_provider_config_id: null,
			provider: null,
		});
	});

	it('cleans up', async () => {
		await safeClose(db);
	});
});
