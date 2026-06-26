import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '003_secret_body_substitution.sql';

describe('003_secret_body_substitution migration', () => {
	let h: DataPreservationHarness;
	let secretId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a secret at the prior schema — represents a production credential
		// (e.g. the existing Umami secret) that must survive the migration.
		const secret = await h.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, allowed_hosts)
			 VALUES ('UMAMI_ADMIN_PASSWORD', 'enc:placeholder', ARRAY['umami.example'])
			 RETURNING id`,
		);
		secretId = secret.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the allow_body_substitution column defaulting to false', async () => {
		const col = await h.db.query<{ column_default: string | null; is_nullable: string }>(
			`SELECT column_default, is_nullable FROM information_schema.columns
			 WHERE table_name = 'secrets' AND column_name = 'allow_body_substitution'`,
		);
		expect(col.rows.length).toBe(1);
		expect(col.rows[0].is_nullable).toBe('NO');
		expect(col.rows[0].column_default).toMatch(/false/);
	});

	it('preserves the pre-existing secret and defaults its flag to false (opt-in)', async () => {
		const kept = await h.db.query<{
			name: string;
			allowed_hosts: string[];
			allow_body_substitution: boolean;
		}>(`SELECT name, allowed_hosts, allow_body_substitution FROM secrets WHERE id = $1`, [
			secretId,
		]);
		expect(kept.rows.length).toBe(1);
		expect(kept.rows[0].name).toBe('UMAMI_ADMIN_PASSWORD');
		expect(kept.rows[0].allowed_hosts).toEqual(['umami.example']);
		expect(kept.rows[0].allow_body_substitution).toBe(false);
	});

	it('allows opting an existing secret into body substitution', async () => {
		await h.db.query(`UPDATE secrets SET allow_body_substitution = true WHERE id = $1`, [secretId]);
		const r = await h.db.query<{ allow_body_substitution: boolean }>(
			`SELECT allow_body_substitution FROM secrets WHERE id = $1`,
			[secretId],
		);
		expect(r.rows[0].allow_body_substitution).toBe(true);
	});
});
