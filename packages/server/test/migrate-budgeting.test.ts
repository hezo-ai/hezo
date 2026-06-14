import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 003_budgeting.sql transforms the frozen 001 baseline into the derived-spend
// budgeting schema: it drops the team budget + running counters and the
// debit_agent_budget() function, adds the daily/weekly windows to agents, adds
// per-window limits to projects, adds the daily/weekly overrides to the
// team-type join table (so clones mirror agent budgets), and adds the windowed
// cost indexes. This drives the REAL migration files through the same
// apply-in-order path production uses (001 -> 002 -> 003) against populated
// data, asserting both the schema delta and that existing rows survive.

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

async function columnExists(db: PGlite, table: string, column: string): Promise<boolean> {
	const r = await db.query(
		`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
		[table, column],
	);
	return r.rows.length > 0;
}

describe('003_budgeting migration', () => {
	let db: PGlite;
	let agentId: string;
	let costId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });

		// Apply the baseline + the smoke migration: the pre-budgeting schema.
		await db.exec(loadMigration('001_initial_schema.sql'));
		await db.exec(loadMigration('002_migration_smoke.sql'));

		// Sanity: the pre-budgeting shape is what we expect to migrate FROM.
		expect(await columnExists(db, 'teams', 'budget_monthly_cents')).toBe(true);
		expect(await columnExists(db, 'member_agents', 'budget_used_cents')).toBe(true);
		expect(await columnExists(db, 'projects', 'daily_budget_cents')).toBe(false);

		// Populate: a team (with an old team budget), an agent (with an old running
		// counter + a tuned monthly budget), a project, and a cost entry.
		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug, budget_monthly_cents) VALUES ('Acme', 'acme', 12345) RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', 'Bot') RETURNING id`,
			[teamId],
		);
		agentId = member.rows[0].id;
		await db.query(
			`INSERT INTO member_agents (id, title, slug, monthly_budget_cents, budget_used_cents)
			 VALUES ($1, 'Bot', 'bot', 4242, 99)`,
			[agentId],
		);
		await db.query(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Ops', 'ops', 'OPS')`,
			[teamId],
		);
		const cost = await db.query<{ id: string }>(
			`INSERT INTO cost_entries (team_id, member_id, amount_cents, description)
			 VALUES ($1, $2, 1234, 'a run') RETURNING id`,
			[teamId, agentId],
		);
		costId = cost.rows[0].id;

		// The actual upgrade step.
		await db.exec(loadMigration('003_budgeting.sql'));
	});

	it('drops the team budget + running counters', async () => {
		expect(await columnExists(db, 'teams', 'budget_monthly_cents')).toBe(false);
		expect(await columnExists(db, 'teams', 'budget_used_cents')).toBe(false);
		expect(await columnExists(db, 'teams', 'budget_reset_at')).toBe(false);
		expect(await columnExists(db, 'member_agents', 'budget_used_cents')).toBe(false);
		expect(await columnExists(db, 'member_agents', 'budget_reset_at')).toBe(false);
	});

	it('adds the daily/weekly agent windows and per-window project limits', async () => {
		expect(await columnExists(db, 'member_agents', 'daily_budget_cents')).toBe(true);
		expect(await columnExists(db, 'member_agents', 'weekly_budget_cents')).toBe(true);
		expect(await columnExists(db, 'projects', 'daily_budget_cents')).toBe(true);
		expect(await columnExists(db, 'projects', 'weekly_budget_cents')).toBe(true);
		expect(await columnExists(db, 'projects', 'monthly_budget_cents')).toBe(true);
	});

	it('adds the daily/weekly overrides to the team-type join table', async () => {
		expect(await columnExists(db, 'team_template_agent_types', 'daily_budget_override')).toBe(true);
		expect(await columnExists(db, 'team_template_agent_types', 'weekly_budget_override')).toBe(
			true,
		);
	});

	it('drops the debit_agent_budget function', async () => {
		const r = await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'debit_agent_budget'`);
		expect(r.rows.length).toBe(0);
	});

	it('adds the windowed cost indexes', async () => {
		const r = await db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_costs_member_created', 'idx_costs_project_created')`,
		);
		expect(r.rows.map((x) => x.indexname).sort()).toEqual([
			'idx_costs_member_created',
			'idx_costs_project_created',
		]);
	});

	it('preserves existing rows through the refactor', async () => {
		// The agent keeps its tuned monthly budget and gains zeroed (unlimited) windows.
		const agent = await db.query<{
			monthly_budget_cents: number;
			daily_budget_cents: number;
			weekly_budget_cents: number;
		}>(
			`SELECT monthly_budget_cents, daily_budget_cents, weekly_budget_cents
			 FROM member_agents WHERE id = $1`,
			[agentId],
		);
		expect(agent.rows[0]).toEqual({
			monthly_budget_cents: 4242,
			daily_budget_cents: 0,
			weekly_budget_cents: 0,
		});

		// The cost entry survives — spend is re-derived from these.
		const cost = await db.query<{ amount_cents: number }>(
			`SELECT amount_cents FROM cost_entries WHERE id = $1`,
			[costId],
		);
		expect(cost.rows[0]?.amount_cents).toBe(1234);
	});

	it('leaves projects defaulting to unlimited (0) per window', async () => {
		const proj = await db.query<{
			daily_budget_cents: number;
			weekly_budget_cents: number;
			monthly_budget_cents: number;
		}>(`SELECT daily_budget_cents, weekly_budget_cents, monthly_budget_cents FROM projects`);
		expect(proj.rows[0]).toEqual({
			daily_budget_cents: 0,
			weekly_budget_cents: 0,
			monthly_budget_cents: 0,
		});
	});

	it('cleans up', async () => {
		await safeClose(db);
	});
});
