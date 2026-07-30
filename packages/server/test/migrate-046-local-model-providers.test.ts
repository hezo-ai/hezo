import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '046_add_local_model_providers.sql';

describe('046_add_local_model_providers migration', () => {
	let h: DataPreservationHarness;
	let seededConfigId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a representative provider config, including metadata, at the prior
		// enum schema. `metadata` is where the local providers will store their
		// operator-supplied base URL, so its survival is part of what's asserted.
		const cfg = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, metadata)
			 VALUES ('anthropic', 'Anthropic', 'enc:placeholder', '{"note":"keep me"}'::jsonb)
			 RETURNING id`,
		);
		seededConfigId = cfg.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds ollama and lmstudio to the ai_provider enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel
			   FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'ai_provider'`,
		);
		const values = r.rows.map((row) => row.enumlabel);
		expect(values).toContain('ollama');
		expect(values).toContain('lmstudio');
	});

	it('preserves pre-existing provider config rows and their metadata', async () => {
		const kept = await h.db.query<{
			provider: string;
			label: string;
			metadata: { note?: string } | null;
		}>(`SELECT provider, label, metadata FROM ai_provider_configs WHERE id = $1`, [seededConfigId]);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].provider).toBe('anthropic');
		expect(kept.rows[0].label).toBe('Anthropic');
		expect(kept.rows[0].metadata?.note).toBe('keep me');
	});

	it('accepts configs using the new values, with a base URL in metadata', async () => {
		const inserted = await h.db.query<{ provider: string; metadata: { base_url?: string } }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, metadata)
			 VALUES ('ollama', 'Ollama', 'enc:placeholder',
			         '{"base_url":"http://host.docker.internal:11434"}'::jsonb)
			 RETURNING provider, metadata`,
		);
		expect(inserted.rows[0].provider).toBe('ollama');
		expect(inserted.rows[0].metadata.base_url).toBe('http://host.docker.internal:11434');

		const lmStudio = await h.db.query<{ provider: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('lmstudio', 'LM Studio', 'enc:placeholder')
			 RETURNING provider`,
		);
		expect(lmStudio.rows[0].provider).toBe('lmstudio');
	});

	it('still accepts the enum values that existed before this migration', async () => {
		const prior = await h.db.query<{ provider: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('openrouter', 'OpenRouter', 'enc:placeholder')
			 RETURNING provider`,
		);
		expect(prior.rows[0].provider).toBe('openrouter');
	});
});
