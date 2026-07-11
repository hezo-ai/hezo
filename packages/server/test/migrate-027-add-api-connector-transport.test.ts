import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '027_add_api_connector_transport.sql';

describe('027_add_api_connector_transport migration', () => {
	let h: DataPreservationHarness;
	let seededConnectorId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a representative connector at the prior (saas/local-only) enum schema.
		const connector = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('typefully', 'saas', '{"url":"https://mcp.typefully.com/mcp"}'::jsonb, 'installed')
			 RETURNING id`,
		);
		seededConnectorId = connector.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds api to the mcp_connection_kind enum', async () => {
		const r = await h.db.query<{ enumlabel: string }>(
			`SELECT e.enumlabel
			   FROM pg_enum e
			   JOIN pg_type t ON t.oid = e.enumtypid
			  WHERE t.typname = 'mcp_connection_kind'`,
		);
		const values = r.rows.map((row) => row.enumlabel);
		expect(values).toContain('api');
		// The prior values are untouched.
		expect(values).toContain('saas');
		expect(values).toContain('local');
	});

	it('preserves the pre-existing connector row', async () => {
		const kept = await h.db.query<{ name: string; kind: string }>(
			`SELECT name, kind::text AS kind FROM mcp_connections WHERE id = $1`,
			[seededConnectorId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0].name).toBe('typefully');
		expect(kept.rows[0].kind).toBe('saas');
	});

	it('accepts a new connector row with kind=api', async () => {
		const inserted = await h.db.query<{ kind: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('weatherapi', 'api'::mcp_connection_kind,
			         '{"base_url":"https://api.weather.example","allowed_hosts":["api.weather.example"],"auth":{"placement":"header","name":"Authorization","scheme":"Bearer "}}'::jsonb,
			         'installed')
			 RETURNING kind::text AS kind`,
		);
		expect(inserted.rows[0].kind).toBe('api');
	});
});
