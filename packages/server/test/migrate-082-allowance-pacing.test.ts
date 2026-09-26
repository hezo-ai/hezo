import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	DEFAULT_MODEL_BACKFILL_META_KEY,
	type DefaultModelBackfill,
} from '../src/db/migrations/code/082_allowance_pacing';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '082_allowance_pacing';

describe('082_allowance_pacing migration', () => {
	let h: DataPreservationHarness;
	const ids: Record<string, string> = {};
	let poolMemberId: string;

	/** One credential row at the prior schema. */
	const seedConfig = async (
		key: string,
		row: { provider: string; auth: string; label: string; model: string | null },
	) => {
		const r = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs
			   (provider, auth_method, label, encrypted_credential, status, default_model, usage_limited_until)
			 VALUES ($1::ai_provider, $2::ai_auth_method, $3, 'ciphertext', 'verified', $4,
			         '2026-10-01T02:43:00Z')
			 RETURNING id`,
			[row.provider, row.auth, row.label, row.model],
		);
		ids[key] = r.rows[0].id;
	};

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		await seedConfig('codexSub', {
			provider: 'openai',
			auth: 'subscription',
			label: 'OpenAI',
			model: null,
		});
		await seedConfig('openaiKey', {
			provider: 'openai',
			auth: 'api_key',
			label: 'Work',
			model: '',
		});
		await seedConfig('claudeKey', {
			provider: 'anthropic',
			auth: 'api_key',
			label: 'Anthropic',
			model: null,
		});
		await seedConfig('ollama', {
			provider: 'ollama',
			auth: 'api_key',
			label: 'Local',
			model: null,
		});
		await seedConfig('chosen', {
			provider: 'google',
			auth: 'api_key',
			label: 'Gemini',
			model: 'gemini-3.1-pro',
		});
		// A refreshed pin, read from the API catalog.
		await h.db.query(
			`INSERT INTO system_meta (key, value) VALUES ('model_pin:openai', 'gpt-5.3-codex'),
			                                             ('model_pin:anthropic', 'claude-opus-5-5')`,
		);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'acme', 'acme', 'AC')
			 RETURNING id`,
			[team.rows[0].id],
		);
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO container_pool_members (project_id, container_id, state, memory_bytes)
			 VALUES ($1, 'ctr-1', 'idle', 4294967296) RETURNING id`,
			[project.rows[0].id],
		);
		poolMemberId = member.rows[0].id;

		await h.applyTarget(TARGET);
	});

	afterAll(async () => {
		await h.close();
	});

	const modelOf = async (key: string) =>
		(
			await h.db.query<{ default_model: string | null }>(
				'SELECT default_model FROM ai_provider_configs WHERE id = $1',
				[ids[key]],
			)
		).rows[0].default_model;

	it('gives a subscription the frozen fallback, never the pin read from an API catalog', async () => {
		expect(await modelOf('codexSub')).toBe('gpt-5.6-sol');
	});

	it('gives an API key the pin refreshed from its catalog, treating an empty model as none', async () => {
		expect(await modelOf('openaiKey')).toBe('gpt-5.3-codex');
		expect(await modelOf('claudeKey')).toBe('claude-opus-5-5');
	});

	it('leaves a local runner without a model, and a chosen model alone', async () => {
		expect(await modelOf('ollama')).toBeNull();
		expect(await modelOf('chosen')).toBe('gemini-3.1-pro');
	});

	it('records every credential it touched for the first-boot notice', async () => {
		const meta = await h.db.query<{ value: string }>(
			'SELECT value FROM system_meta WHERE key = $1',
			[DEFAULT_MODEL_BACKFILL_META_KEY],
		);
		const record = JSON.parse(meta.rows[0].value) as DefaultModelBackfill[];
		expect(record).toEqual([
			{ label: 'OpenAI', provider: 'openai', model: 'gpt-5.6-sol' },
			{ label: 'Work', provider: 'openai', model: 'gpt-5.3-codex' },
			{ label: 'Anthropic', provider: 'anthropic', model: 'claude-opus-5-5' },
			{ label: 'Local', provider: 'ollama', model: null },
		]);
	});

	it('keeps each credential row and its hold, and starts the pacing columns empty', async () => {
		const rows = await h.db.query<{
			n: number;
			held: number;
			seen: number;
		}>(
			`SELECT count(*)::int AS n,
			        count(*) FILTER (WHERE usage_limited_until = '2026-10-01T02:43:00Z')::int AS held,
			        count(allowance_used_percent)::int + count(allowance_daily_share_percent)::int AS seen
			   FROM ai_provider_configs`,
		);
		expect(rows.rows[0]).toEqual({ n: 5, held: 5, seen: 0 });
	});

	it('keeps pooled containers and adds the image columns', async () => {
		const member = await h.db.query<{ container_id: string; image_version: string | null }>(
			'SELECT container_id, image_version FROM container_pool_members WHERE id = $1',
			[poolMemberId],
		);
		expect(member.rows[0]).toEqual({ container_id: 'ctr-1', image_version: null });
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			  WHERE table_name = 'heartbeat_runs' AND column_name IN ('stop_reason', 'image_version')
			  ORDER BY column_name`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual(['image_version', 'stop_reason']);
	});
});
