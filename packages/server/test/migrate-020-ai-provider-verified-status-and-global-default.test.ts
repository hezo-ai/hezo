import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '020_ai_provider_verified_status_and_global_default.sql';

/**
 * 020 renames the healthy provider status 'active' -> 'verified' and collapses the
 * per-provider `is_default` flag into a single instance-wide default. Seed at 019
 * (status 'active', one default per provider) with two providers each marked default
 * plus an 'invalid' row, then assert the migration preserves every row AND applies
 * both changes.
 */
describe('020_ai_provider_verified_status_and_global_default migration', () => {
	let h: DataPreservationHarness;
	let anthropicId: string; // active + default, older -> stays the single default
	let googleId: string; // active + default, newer -> demoted
	let deepseekId: string; // invalid, not default -> status untouched

	async function seedConfig(opts: {
		provider: string;
		label: string;
		status: string;
		isDefault: boolean;
		createdAt: string;
	}): Promise<string> {
		const r = await h.db.query<{ id: string }>(
			`INSERT INTO ai_provider_configs
			   (provider, label, encrypted_credential, is_default, status, created_at)
			 VALUES ($1::ai_provider, $2, 'enc', $3, $4, $5)
			 RETURNING id`,
			[opts.provider, opts.label, opts.isDefault, opts.status, opts.createdAt],
		);
		return r.rows[0].id;
	}

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// The old per-provider unique index allows one default per provider, so two
		// providers can each carry is_default = true at the prior schema.
		anthropicId = await seedConfig({
			provider: 'anthropic',
			label: 'anthropic-a',
			status: 'active',
			isDefault: true,
			createdAt: '2024-01-01T00:00:00Z',
		});
		googleId = await seedConfig({
			provider: 'google',
			label: 'google-a',
			status: 'active',
			isDefault: true,
			createdAt: '2024-02-01T00:00:00Z',
		});
		deepseekId = await seedConfig({
			provider: 'deepseek',
			label: 'deepseek-a',
			status: 'invalid',
			isDefault: false,
			createdAt: '2024-03-01T00:00:00Z',
		});

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves every seeded row', async () => {
		const c = await h.db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ai_provider_configs`);
		expect(c.rows[0].c).toBe(3);
		const ids = await h.db.query<{ id: string }>(
			`SELECT id FROM ai_provider_configs WHERE id = ANY($1::uuid[])`,
			[[anthropicId, googleId, deepseekId]],
		);
		expect(ids.rows.length).toBe(3);
	});

	it("renames 'active' rows to 'verified' and leaves 'invalid' untouched", async () => {
		const rows = await h.db.query<{ id: string; status: string }>(
			`SELECT id, status FROM ai_provider_configs`,
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
		expect(byId.get(anthropicId)).toBe('verified');
		expect(byId.get(googleId)).toBe('verified');
		expect(byId.get(deepseekId)).toBe('invalid');
	});

	it('keeps exactly one instance-wide default (the oldest previously-default row)', async () => {
		const defaults = await h.db.query<{ id: string }>(
			`SELECT id FROM ai_provider_configs WHERE is_default = true`,
		);
		expect(defaults.rows.length).toBe(1);
		expect(defaults.rows[0].id).toBe(anthropicId);
	});

	it("defaults the status column to 'verified' for new rows", async () => {
		const r = await h.db.query<{ status: string }>(
			`INSERT INTO ai_provider_configs (provider, label, encrypted_credential)
			 VALUES ('kimi'::ai_provider, 'kimi-new', 'enc')
			 RETURNING status`,
		);
		expect(r.rows[0].status).toBe('verified');
	});

	it('enforces a single global default via the unique index', async () => {
		// anthropic is already the default; promoting a second row must collide.
		await expect(
			h.db.query(`UPDATE ai_provider_configs SET is_default = true WHERE id = $1`, [googleId]),
		).rejects.toThrow();
	});
});
