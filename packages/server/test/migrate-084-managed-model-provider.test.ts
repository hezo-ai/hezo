import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '084_managed_model_provider.sql';

describe('084_managed_model_provider migration', () => {
	let h: DataPreservationHarness;
	let seededConfigId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// A credential at the prior enum schema, with metadata, since a managed row
		// keeps its endpoint and headers there too.
		const cfg = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, is_default, metadata)
			 VALUES ('deepseek', 'DeepSeek', 'enc:placeholder', true, '{"note":"keep me"}'::jsonb)
			 RETURNING id`,
		);
		seededConfigId = cfg.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds hezo_cloud to the ai_provider enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel
			   FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'ai_provider'`,
		);
		expect(r.rows.map((row) => row.enumlabel)).toContain('hezo_cloud');
	});

	it('preserves pre-existing provider config rows, their default and their metadata', async () => {
		const kept = await h.db.query<{
			provider: string;
			label: string;
			is_default: boolean;
			metadata: { note?: string } | null;
		}>(`SELECT provider, label, is_default, metadata FROM ai_provider_configs WHERE id = $1`, [
			seededConfigId,
		]);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0]).toMatchObject({
			provider: 'deepseek',
			label: 'DeepSeek',
			is_default: true,
		});
		expect(kept.rows[0].metadata?.note).toBe('keep me');
	});

	it('accepts a managed config carrying its endpoint and headers in metadata', async () => {
		const inserted = await h.db.query<{
			provider: string;
			metadata: { base_url?: string; request_headers?: Record<string, string> };
		}>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential, metadata)
			 VALUES ('hezo_cloud', 'Base AI model', 'enc:placeholder',
			         '{"base_url":"https://models.example/api","request_headers":{"x-session-id":"tenant-1"}}'::jsonb)
			 RETURNING provider, metadata`,
		);
		expect(inserted.rows[0].provider).toBe('hezo_cloud');
		expect(inserted.rows[0].metadata.base_url).toBe('https://models.example/api');
		expect(inserted.rows[0].metadata.request_headers).toEqual({ 'x-session-id': 'tenant-1' });
	});
});
