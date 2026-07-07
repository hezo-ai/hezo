import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '019_mcp_connection_api_key.sql';

describe('019_mcp_connection_api_key migration', () => {
	let h: DataPreservationHarness;
	let seededConnectorId: string;
	let seededSecretId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a connector at the prior schema (no api_key_secret_id column yet)
		// plus a vault secret it can later point at.
		const connector = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('typefully', 'saas', '{"url":"https://mcp.typefully.com/mcp"}'::jsonb, 'installed')
			 RETURNING id`,
		);
		seededConnectorId = connector.rows[0].id;

		const secret = await h.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ('MCP_TYPEFULLY_API_KEY', 'enc', 'api_token'::secret_category, '{mcp.typefully.com}')
			 RETURNING id`,
		);
		seededSecretId = secret.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the api_key_secret_id column', async () => {
		const cols = await h.db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name = 'mcp_connections' AND column_name = 'api_key_secret_id'`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual(['api_key_secret_id']);
	});

	it('preserves the pre-existing connector row (api_key_secret_id defaults NULL)', async () => {
		const kept = await h.db.query<{ name: string; api_key_secret_id: string | null }>(
			`SELECT name, api_key_secret_id FROM mcp_connections WHERE id = $1`,
			[seededConnectorId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0].name).toBe('typefully');
		expect(kept.rows[0].api_key_secret_id).toBeNull();
	});

	it('links a connector to a secret and SET NULLs on secret delete', async () => {
		await h.db.query(`UPDATE mcp_connections SET api_key_secret_id = $1 WHERE id = $2`, [
			seededSecretId,
			seededConnectorId,
		]);
		const linked = await h.db.query<{ api_key_secret_id: string }>(
			`SELECT api_key_secret_id FROM mcp_connections WHERE id = $1`,
			[seededConnectorId],
		);
		expect(linked.rows[0].api_key_secret_id).toBe(seededSecretId);

		// ON DELETE SET NULL: deleting the secret deactivates the connector cleanly.
		await h.db.query(`DELETE FROM secrets WHERE id = $1`, [seededSecretId]);
		const after = await h.db.query<{ api_key_secret_id: string | null }>(
			`SELECT api_key_secret_id FROM mcp_connections WHERE id = $1`,
			[seededConnectorId],
		);
		expect(after.rows[0].api_key_secret_id).toBeNull();
	});
});
