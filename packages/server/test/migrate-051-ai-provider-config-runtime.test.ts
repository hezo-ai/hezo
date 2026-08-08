import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '051_ai_provider_config_runtime.sql';

/**
 * 051 adds `ai_provider_configs.runtime` so a credential can name the CLI that
 * runs it. The two things that matter: pre-existing credentials survive intact,
 * and they come out with a NULL runtime rather than a backfilled default — NULL
 * is what keeps them following the provider default if that default ever moves.
 */
describe('051_ai_provider_config_runtime migration', () => {
	let h: DataPreservationHarness;
	let kimiId: string;
	let anthropicId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const kimi = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status, default_model)
			 VALUES ('kimi', 'api_key', 'Kimi', 'enc-kimi', true, 'verified', 'kimi-k2.7-code')
			 RETURNING id`,
		);
		kimiId = kimi.rows[0].id;

		const anthropic = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, auth_method, label, encrypted_credential, is_default, status)
			 VALUES ('anthropic', 'subscription', 'Anthropic', 'enc-anthropic', false, 'verified')
			 RETURNING id`,
		);
		anthropicId = anthropic.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the runtime column, typed as agent_runtime and nullable', async () => {
		const col = await h.db.query<{ data_type: string; udt_name: string; is_nullable: string }>(
			`SELECT data_type, udt_name, is_nullable FROM information_schema.columns
			 WHERE table_name = 'ai_provider_configs' AND column_name = 'runtime'`,
		);
		expect(col.rows.length).toBe(1);
		expect(col.rows[0].udt_name).toBe('agent_runtime');
		expect(col.rows[0].is_nullable).toBe('YES');
	});

	it('preserves pre-existing credentials with every field intact', async () => {
		const kept = await h.db.query<{
			id: string;
			provider: string;
			auth_method: string;
			label: string;
			encrypted_credential: string;
			is_default: boolean;
			status: string;
			default_model: string | null;
		}>(
			`SELECT id, provider, auth_method, label, encrypted_credential, is_default, status, default_model
			 FROM ai_provider_configs ORDER BY label`,
		);
		expect(kept.rows.length).toBe(2);

		const anthropic = kept.rows.find((r) => r.id === anthropicId);
		expect(anthropic).toMatchObject({
			provider: 'anthropic',
			auth_method: 'subscription',
			label: 'Anthropic',
			encrypted_credential: 'enc-anthropic',
			is_default: false,
			status: 'verified',
		});

		const kimi = kept.rows.find((r) => r.id === kimiId);
		expect(kimi).toMatchObject({
			provider: 'kimi',
			auth_method: 'api_key',
			label: 'Kimi',
			encrypted_credential: 'enc-kimi',
			is_default: true,
			status: 'verified',
			default_model: 'kimi-k2.7-code',
		});
	});

	it('leaves existing rows NULL rather than backfilling a default', async () => {
		const runtimes = await h.db.query<{ runtime: string | null }>(
			`SELECT runtime FROM ai_provider_configs`,
		);
		expect(runtimes.rows.length).toBe(2);
		expect(runtimes.rows.every((r) => r.runtime === null)).toBe(true);
	});

	it('accepts an explicit runtime on the migrated column', async () => {
		await h.db.query(
			`UPDATE ai_provider_configs SET runtime = 'kimi'::agent_runtime WHERE id = $1`,
			[kimiId],
		);
		const updated = await h.db.query<{ runtime: string | null }>(
			`SELECT runtime FROM ai_provider_configs WHERE id = $1`,
			[kimiId],
		);
		expect(updated.rows[0].runtime).toBe('kimi');
	});
});
