import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { beforeAll, describe, expect, it } from 'vitest';
import { safeClose } from './helpers';

// 008_opencode_kimi_runtimes.sql extends two in-use enums — agent_runtime
// (+opencode/+kimi) and ai_provider (+openrouter/+kimi). Postgres can't ADD a
// value inside the transaction the runner wraps each migration in, so the
// migration recreates each type and swaps every column that uses it. This drives
// the real migration through the apply-in-order path against populated rows and
// asserts the existing values cast across untouched and the new ones become
// insertable.

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

describe('008_opencode_kimi_runtimes migration', () => {
	let db: PGlite;
	let providerConfigId: string;
	let agentId: string;

	beforeAll(async () => {
		db = new PGlite({ extensions: { vector } });

		for (const f of [
			'001_initial_schema.sql',
			'002_migration_smoke.sql',
			'003_budgeting.sql',
			'004_cost_provider_tracking.sql',
			'005_model_pricing.sql',
			'006_budget_runtime_states.sql',
			'007_comment_public_id.sql',
		]) {
			await db.exec(loadMigration(f));
		}

		// Pre-008 the enums hold only the original values.
		expect(await enumValues(db, 'agent_runtime')).toEqual(['claude_code', 'codex', 'gemini']);
		expect(await enumValues(db, 'ai_provider')).toEqual([
			'anthropic',
			'openai',
			'google',
			'deepseek',
			'z_ai',
		]);

		const provider = await db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('anthropic', 'primary', 'enc') RETURNING id`,
		);
		providerConfigId = provider.rows[0].id;

		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const member = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', 'bot') RETURNING id`,
			[teamId],
		);
		agentId = member.rows[0].id;
		// A non-default provider override exercises casting a non-anthropic value.
		await db.query(
			`INSERT INTO member_agents (id, title, slug, model_override_provider)
			 VALUES ($1, 'bot', 'bot', 'openai'::ai_provider)`,
			[agentId],
		);

		await db.exec(`BEGIN;\n${loadMigration('008_opencode_kimi_runtimes.sql')}\nCOMMIT;`);
	});

	it('adds opencode + kimi to agent_runtime', async () => {
		expect(await enumValues(db, 'agent_runtime')).toEqual([
			'claude_code',
			'codex',
			'gemini',
			'opencode',
			'kimi',
		]);
	});

	it('adds openrouter + kimi to ai_provider', async () => {
		expect(await enumValues(db, 'ai_provider')).toEqual([
			'anthropic',
			'openai',
			'google',
			'deepseek',
			'z_ai',
			'openrouter',
			'kimi',
		]);
	});

	it('preserves existing provider + override rows across the swap', async () => {
		const cfg = await db.query<{ provider: string }>(
			'SELECT provider FROM ai_provider_configs WHERE id = $1',
			[providerConfigId],
		);
		expect(cfg.rows[0].provider).toBe('anthropic');
		const agent = await db.query<{ model_override_provider: string }>(
			'SELECT model_override_provider FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agent.rows[0].model_override_provider).toBe('openai');
	});

	it('accepts the new provider + runtime values after the migration', async () => {
		await db.query(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('openrouter', 'or', 'enc'), ('kimi', 'kimi', 'enc')`,
		);
		await db.query('UPDATE tasks SET runtime_type = NULL'); // no-op; proves column is typed
		const r = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM ai_provider_configs WHERE provider IN ('openrouter','kimi')`,
		);
		expect(r.rows[0].count).toBe(2);
		await safeClose(db);
	});
});
