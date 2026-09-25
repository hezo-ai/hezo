import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '081_add_requesty_provider.sql';

describe('081_add_requesty_provider migration', () => {
	let h: DataPreservationHarness;
	let seededConfigId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const cfg = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, metadata)
			 VALUES ('openrouter', 'OpenRouter', 'enc:placeholder', '{"note":"keep me"}'::jsonb)
			 RETURNING id`,
		);
		seededConfigId = cfg.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds requesty to the ai_provider enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel
			   FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'ai_provider'`,
		);
		expect(r.rows.map((row) => row.enumlabel)).toContain('requesty');
	});

	it('preserves pre-existing provider config rows and their metadata', async () => {
		const kept = await h.db.query<{
			provider: string;
			label: string;
			metadata: { note?: string } | null;
		}>(`SELECT provider, label, metadata FROM ai_provider_configs WHERE id = $1`, [seededConfigId]);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].provider).toBe('openrouter');
		expect(kept.rows[0].label).toBe('OpenRouter');
		expect(kept.rows[0].metadata?.note).toBe('keep me');
	});

	it('accepts a config using the new value', async () => {
		const inserted = await h.db.query<{ provider: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('requesty', 'Requesty', 'enc:placeholder')
			 RETURNING provider`,
		);
		expect(inserted.rows[0].provider).toBe('requesty');
	});
});
