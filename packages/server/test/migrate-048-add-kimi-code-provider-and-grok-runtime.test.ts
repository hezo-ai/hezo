import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '048_add_kimi_code_provider_and_grok_runtime.sql';

describe('048_add_kimi_code_provider_and_grok_runtime migration', () => {
	let h: DataPreservationHarness;
	let seededKimiConfigId: string;
	let pinnedTaskId: string;
	let unpinnedTaskId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// A config on the EXISTING `kimi` provider. This is the row that matters most:
		// the whole point of the change is that adding `kimi_code` leaves
		// Kimi-on-Claude-Code alone, so an operator already running Kimi is untouched
		// by the upgrade.
		const cfg = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, is_default, metadata)
			 VALUES ('kimi', 'Kimi', 'enc:placeholder', true, '{"note":"keep me"}'::jsonb)
			 RETURNING id`,
		);
		seededKimiConfigId = cfg.rows[0].id;

		// Minimal project/team scaffolding so tasks can carry a runtime pin.
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Demo', 'demo', 'DEMO') RETURNING id`,
			[teamId],
		);
		const projectId = project.rows[0].id;

		// One task pinned to a pre-existing runtime, one unpinned — both must survive
		// the enum extension unchanged.
		const pinned = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (project_id, team_id, number, identifier, title, runtime_type)
			 VALUES ($1, $2, 1, 'DEMO-1', 'Pinned to claude_code', 'claude_code'::agent_runtime)
			 RETURNING id`,
			[projectId, teamId],
		);
		pinnedTaskId = pinned.rows[0].id;

		const unpinned = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (project_id, team_id, number, identifier, title)
			 VALUES ($1, $2, 2, 'DEMO-2', 'No runtime pin')
			 RETURNING id`,
			[projectId, teamId],
		);
		unpinnedTaskId = unpinned.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	// --- 1. the kimi_code provider -------------------------------------------

	it('adds kimi_code to the ai_provider enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'ai_provider'`,
		);
		expect(r.rows.map((row) => row.enumlabel)).toContain('kimi_code');
	});

	it('leaves the existing kimi provider config intact and still default', async () => {
		const kept = await h.db.query<{
			provider: string;
			label: string;
			is_default: boolean;
			metadata: { note?: string } | null;
		}>(`SELECT provider, label, is_default, metadata FROM ai_provider_configs WHERE id = $1`, [
			seededKimiConfigId,
		]);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].provider).toBe('kimi');
		expect(kept.rows[0].label).toBe('Kimi');
		expect(kept.rows[0].is_default).toBe(true);
		expect(kept.rows[0].metadata?.note).toBe('keep me');
	});

	it('allows both kimi providers to be configured side by side', async () => {
		await h.db.query(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('kimi_code', 'Kimi Code', 'enc:placeholder')`,
		);
		const both = await h.db.query<{ provider: string }>(
			`SELECT provider FROM ai_provider_configs
			  WHERE provider IN ('kimi', 'kimi_code') ORDER BY provider`,
		);
		expect(both.rows.map((r) => r.provider)).toEqual(['kimi', 'kimi_code']);
	});

	it('needs no agent_runtime change for the Kimi Code runtime itself', async () => {
		// The new runtime reuses the `kimi` label 001 created and 010 retired, which
		// is why this migration extends `agent_runtime` only for grok.
		const cast = await h.db.query<{ runtime: string }>(`SELECT 'kimi'::agent_runtime AS runtime`);
		expect(cast.rows[0].runtime).toBe('kimi');
	});

	// --- 2. the grok runtime fix ---------------------------------------------

	it('adds grok to the agent_runtime enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'agent_runtime'`,
		);
		expect(r.rows.map((row) => row.enumlabel)).toContain('grok');
	});

	it('makes the cast that previously failed succeed', async () => {
		// The actual bug: routes/tasks.ts, mcp/tools.ts and chat-session-manager.ts
		// all write `$N::agent_runtime`, so before this migration a resolved Grok
		// runtime raised `invalid input value for enum agent_runtime: "grok"`.
		const cast = await h.db.query<{ runtime: string }>(`SELECT 'grok'::agent_runtime AS runtime`);
		expect(cast.rows[0].runtime).toBe('grok');
	});

	it('accepts a task runtime pin on grok', async () => {
		const updated = await h.db.query<{ runtime_type: string }>(
			`UPDATE tasks SET runtime_type = 'grok'::agent_runtime WHERE id = $1
			 RETURNING runtime_type`,
			[unpinnedTaskId],
		);
		expect(updated.rows[0].runtime_type).toBe('grok');
	});

	// --- 3. nothing else moved ------------------------------------------------

	it('preserves pre-existing task rows and their runtime pins', async () => {
		const kept = await h.db.query<{ title: string; runtime_type: string | null }>(
			`SELECT title, runtime_type FROM tasks WHERE id = $1`,
			[pinnedTaskId],
		);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].title).toBe('Pinned to claude_code');
		expect(kept.rows[0].runtime_type).toBe('claude_code');
	});

	it('still accepts every enum value that existed before this migration', async () => {
		for (const runtime of ['claude_code', 'codex', 'gemini', 'opencode', 'kimi']) {
			const cast = await h.db.query<{ runtime: string }>(`SELECT $1::agent_runtime AS runtime`, [
				runtime,
			]);
			expect(cast.rows[0].runtime).toBe(runtime);
		}
		const prior = await h.db.query<{ provider: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('openrouter', 'OpenRouter', 'enc:placeholder')
			 RETURNING provider`,
		);
		expect(prior.rows[0].provider).toBe('openrouter');
	});
});
