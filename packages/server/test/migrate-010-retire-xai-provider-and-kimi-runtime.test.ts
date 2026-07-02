import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '010_retire_xai_provider_and_kimi_runtime.sql';

describe('010_retire_xai_provider_and_kimi_runtime migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let xaiConfigId: string;
	let anthropicConfigId: string;
	let xaiAgentId: string;
	let anthropicAgentId: string;
	let kimiTaskId: string;
	let codexTaskId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema at 009 — 'x_ai' selectable, 'kimi' runtime pinnable

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Ops', 'ops', 'OPS') RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;

		// A stale default xAI config (the row the resolver would pick first) and a
		// healthy Anthropic config that must be left untouched.
		const xaiConfig = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, is_default, status)
			 VALUES ('x_ai', 'Grok', 'enc:xai', true, 'active') RETURNING id`,
		);
		xaiConfigId = xaiConfig.rows[0].id;
		const anthropicConfig = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, is_default, status)
			 VALUES ('anthropic', 'Claude', 'enc:anthropic', false, 'active') RETURNING id`,
		);
		anthropicConfigId = anthropicConfig.rows[0].id;

		// Two agents: one overridden to x_ai (must fall back to instance default),
		// one overridden to anthropic (must be untouched).
		const mkAgent = async (name: string, provider: string | null, model: string | null) => {
			const member = await h.db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, 'agent', $2) RETURNING id`,
				[teamId, name],
			);
			const memberId = member.rows[0].id;
			await h.db.query(
				`INSERT INTO member_agents (id, title, slug, model_override_provider, model_override_model)
				 VALUES ($1, $2, $3, $4::ai_provider, $5)`,
				[memberId, name, name.toLowerCase(), provider, model],
			);
			return memberId;
		};
		xaiAgentId = await mkAgent('Grokster', 'x_ai', 'grok-4-fast');
		anthropicAgentId = await mkAgent('Clauden', 'anthropic', 'claude-sonnet-5');

		// Two tasks: one pinned to the removed kimi runtime, one to a surviving runtime.
		const mkTask = async (n: number, runtime: string) => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, number, identifier, title, runtime_type)
				 VALUES ($1, $2, $3, $4, $5, $6::agent_runtime) RETURNING id`,
				[teamId, projectId, n, `OPS-${n}`, `Task ${n}`, runtime],
			);
			return r.rows[0].id;
		};
		kimiTaskId = await mkTask(1, 'kimi');
		codexTaskId = await mkTask(2, 'codex');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('revokes the x_ai provider config, keeping the row and credential', async () => {
		const row = await h.db.query<{ status: string; is_default: boolean; cred: string }>(
			`SELECT status, is_default, encrypted_credential AS cred FROM ai_provider_configs WHERE id = $1`,
			[xaiConfigId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].status).toBe('revoked');
		expect(row.rows[0].is_default).toBe(false);
		expect(row.rows[0].cred).toBe('enc:xai');
	});

	it('leaves other provider configs untouched', async () => {
		const row = await h.db.query<{ status: string }>(
			`SELECT status FROM ai_provider_configs WHERE id = $1`,
			[anthropicConfigId],
		);
		expect(row.rows[0].status).toBe('active');
	});

	it('clears x_ai model overrides (provider and model together) and keeps others', async () => {
		const cleared = await h.db.query<{ provider: string | null; model: string | null }>(
			`SELECT model_override_provider::text AS provider, model_override_model AS model
			 FROM member_agents WHERE id = $1`,
			[xaiAgentId],
		);
		expect(cleared.rows[0].provider).toBeNull();
		expect(cleared.rows[0].model).toBeNull();

		const kept = await h.db.query<{ provider: string | null; model: string | null }>(
			`SELECT model_override_provider::text AS provider, model_override_model AS model
			 FROM member_agents WHERE id = $1`,
			[anthropicAgentId],
		);
		expect(kept.rows[0].provider).toBe('anthropic');
		expect(kept.rows[0].model).toBe('claude-sonnet-5');
	});

	it('unpins kimi runtime tasks and keeps other runtime pins', async () => {
		const unpinned = await h.db.query<{ runtime: string | null }>(
			`SELECT runtime_type::text AS runtime FROM tasks WHERE id = $1`,
			[kimiTaskId],
		);
		expect(unpinned.rows[0].runtime).toBeNull();

		const kept = await h.db.query<{ runtime: string | null }>(
			`SELECT runtime_type::text AS runtime FROM tasks WHERE id = $1`,
			[codexTaskId],
		);
		expect(kept.rows[0].runtime).toBe('codex');
	});
});
