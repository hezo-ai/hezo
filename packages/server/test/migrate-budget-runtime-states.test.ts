import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 006_budget_runtime_states.sql reshapes the agent runtime-status enum: it drops
// the unused `paused` value (manual on/off is `admin_status`, a separate axis)
// and replaces it with two scoped, reactive budget pauses (`out_of_agent_budget`
// / `out_of_project_budget`). Postgres can't drop an enum value in place, so the
// migration recreates the type and swaps the `member_agents.runtime_status`
// column over, mapping any existing `paused` row to `idle`. This drives the REAL
// migration files through the apply-in-order path production uses, inside the
// per-migration transaction the runner wraps each file in — the case that
// matters, since the type swap (DROP TYPE + RENAME) is transaction-sensitive.

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

async function enumValues(db: PGlite, typeName: string): Promise<string[]> {
	const r = await db.query<{ enumlabel: string }>(
		`SELECT e.enumlabel FROM pg_enum e
		 JOIN pg_type ty ON ty.oid = e.enumtypid
		 WHERE ty.typname = $1 ORDER BY e.enumsortorder`,
		[typeName],
	);
	return r.rows.map((row) => row.enumlabel);
}

async function getStatus(db: PGlite, id: string): Promise<string> {
	const r = await db.query<{ runtime_status: string }>(
		'SELECT runtime_status FROM member_agents WHERE id = $1',
		[id],
	);
	return r.rows[0].runtime_status;
}

describe('006_budget_runtime_states migration', () => {
	let db: PGlite;
	let pausedAgentId: string;
	let idleAgentId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });

		// Apply everything up to (but not including) 006 — the pre-split schema.
		for (const f of [
			'001_initial_schema.sql',
			'002_migration_smoke.sql',
			'003_budgeting.sql',
			'004_cost_provider_tracking.sql',
			'005_model_pricing.sql',
		]) {
			await db.exec(loadMigration(f));
		}

		// Sanity: only the three original runtime states exist pre-006.
		expect(await enumValues(db, 'agent_runtime_status')).toEqual(['active', 'idle', 'paused']);

		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const mkAgent = async (slug: string, status: string): Promise<string> => {
			const member = await db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', $2) RETURNING id`,
				[teamId, slug],
			);
			const id = member.rows[0].id;
			await db.query(
				`INSERT INTO member_agents (id, title, slug, runtime_status)
				 VALUES ($1, $2, $3, $4::agent_runtime_status)`,
				[id, slug, slug, status],
			);
			return id;
		};
		// A budget-paused agent under the old scheme, plus an idle one to prove the
		// reset is scoped to `paused` rows only.
		pausedAgentId = await mkAgent('paused-bot', 'paused');
		idleAgentId = await mkAgent('idle-bot', 'idle');

		// Apply 006 inside an explicit transaction — exactly how the runner applies
		// each migration. This is the load-bearing assertion: ADD VALUE + a same-txn
		// reset of existing rows must succeed together.
		await db.exec(`BEGIN;\n${loadMigration('006_budget_runtime_states.sql')}\nCOMMIT;`);
	});

	it('replaces `paused` with the two scoped budget-pause enum values', async () => {
		expect(await enumValues(db, 'agent_runtime_status')).toEqual([
			'active',
			'idle',
			'out_of_agent_budget',
			'out_of_project_budget',
		]);
	});

	it('maps pre-existing paused agents to idle', async () => {
		expect(await getStatus(db, pausedAgentId)).toBe('idle');
	});

	it('leaves non-paused agents untouched', async () => {
		expect(await getStatus(db, idleAgentId)).toBe('idle');
	});

	it('accepts the new scoped states after the migration', async () => {
		await db.query(
			`UPDATE member_agents SET runtime_status = 'out_of_project_budget' WHERE id = $1`,
			[pausedAgentId],
		);
		expect(await getStatus(db, pausedAgentId)).toBe('out_of_project_budget');
	});

	it('preserves data through the swap (agents survive)', async () => {
		const r = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM member_agents');
		expect(r.rows[0].count).toBe(2);
		await safeClose(db);
	});
});
