import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '006_add_xai_provider.sql';

describe('006_add_xai_provider migration', () => {
	let h: DataPreservationHarness;
	let seededConfigId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a representative provider config at the prior (7-value) enum schema.
		const cfg = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('anthropic', 'Anthropic', 'enc:placeholder')
			 RETURNING id`,
		);
		seededConfigId = cfg.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds x_ai to the ai_provider enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel
			   FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'ai_provider'`,
		);
		const values = r.rows.map((row) => row.enumlabel);
		expect(values).toContain('x_ai');
	});

	it('preserves pre-existing provider config rows', async () => {
		const kept = await h.db.query<{ provider: string; label: string }>(
			`SELECT provider, label FROM ai_provider_configs WHERE id = $1`,
			[seededConfigId],
		);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].provider).toBe('anthropic');
		expect(kept.rows[0].label).toBe('Anthropic');
	});

	it('accepts a new config that uses the x_ai value', async () => {
		const inserted = await h.db.query<{ provider: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('x_ai', 'xAI', 'enc:placeholder')
			 RETURNING provider`,
		);
		expect(inserted.rows[0].provider).toBe('x_ai');
	});
});
