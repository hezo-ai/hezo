import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '028_oauth_connection_client_secret.sql';

describe('028_oauth_connection_client_secret migration', () => {
	let h: DataPreservationHarness;
	let seededConnId: string;
	let seededAccessSecretId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a representative access-token secret + an oauth_connections row
		// referencing it at the prior schema (satisfying every NOT NULL column).
		const secret = await h.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts)
			 VALUES ('OAUTH_GOOGLE_YOUTUBE_ABCDEF01', 'ciphertext', 'api_token', ARRAY['oauth2.googleapis.com'], false)
			 RETURNING id`,
		);
		seededAccessSecretId = secret.rows[0].id;

		const conn = await h.db.query<{ id: string }>(
			`INSERT INTO oauth_connections
			   (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
			 VALUES ('google-youtube', 'google-youtube:acct', 'YouTube', $1, ARRAY['https://www.googleapis.com/auth/youtube'])
			 RETURNING id`,
			[seededAccessSecretId],
		);
		seededConnId = conn.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the client_secret_secret_id column', async () => {
		const c = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'oauth_connections' AND column_name = 'client_secret_secret_id'`,
		);
		expect(c.rows[0].c).toBe(1);
	});

	it('preserves the pre-existing oauth_connection with its access token intact and client secret NULL', async () => {
		const kept = await h.db.query<{
			provider: string;
			access_token_secret_id: string;
			client_secret_secret_id: string | null;
		}>(
			`SELECT provider, access_token_secret_id, client_secret_secret_id
			 FROM oauth_connections WHERE id = $1`,
			[seededConnId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0].provider).toBe('google-youtube');
		expect(kept.rows[0].access_token_secret_id).toBe(seededAccessSecretId);
		expect(kept.rows[0].client_secret_secret_id).toBeNull();
	});

	it('accepts a client_secret_secret_id referencing a secrets row', async () => {
		const cs = await h.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts)
			 VALUES ('OAUTH_GOOGLE_YOUTUBE_ABCDEF01_CLIENT_SECRET', 'ciphertext2', 'api_token', '{}', false)
			 RETURNING id`,
		);
		await h.db.query(`UPDATE oauth_connections SET client_secret_secret_id = $1 WHERE id = $2`, [
			cs.rows[0].id,
			seededConnId,
		]);
		const after = await h.db.query<{ client_secret_secret_id: string | null }>(
			`SELECT client_secret_secret_id FROM oauth_connections WHERE id = $1`,
			[seededConnId],
		);
		expect(after.rows[0].client_secret_secret_id).toBe(cs.rows[0].id);
	});
});
