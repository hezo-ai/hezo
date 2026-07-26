import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '043_connector_method_access.sql';

describe('043_connector_method_access migration', () => {
	let h: DataPreservationHarness;
	let seededConnectorId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a connector at the prior schema (none of the method-access columns
		// exist yet) so we can assert it survives untouched and unrestricted.
		const connector = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('linear', 'saas', '{"url":"https://mcp.linear.app/mcp"}'::jsonb, 'installed')
			 RETURNING id`,
		);
		seededConnectorId = connector.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the method-access columns', async () => {
		const cols = await h.db.query<{ column_name: string; data_type: string }>(
			`SELECT column_name, data_type FROM information_schema.columns
			 WHERE table_name = 'mcp_connections'
			   AND column_name IN ('enabled_methods', 'discovered_methods', 'methods_listed_at',
			                       'requested_access', 'access_applied_at')
			 ORDER BY column_name`,
		);
		expect(cols.rows.map((r) => r.column_name)).toEqual([
			'access_applied_at',
			'discovered_methods',
			'enabled_methods',
			'methods_listed_at',
			'requested_access',
		]);
		const byName = new Map(cols.rows.map((r) => [r.column_name, r.data_type]));
		expect(byName.get('enabled_methods')).toBe('jsonb');
		expect(byName.get('discovered_methods')).toBe('jsonb');
	});

	it('creates the connector_access enum with read and write', async () => {
		const labels = await h.db.query<{ enumlabel: string }>(
			`SELECT enumlabel FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'connector_access'
			 ORDER BY e.enumsortorder`,
		);
		expect(labels.rows.map((r) => r.enumlabel)).toEqual(['read', 'write']);
	});

	it('preserves the pre-existing connector row, unrestricted', async () => {
		const kept = await h.db.query<{
			name: string;
			config: { url: string };
			enabled_methods: string[] | null;
			discovered_methods: unknown | null;
			requested_access: string | null;
			access_applied_at: string | null;
		}>(
			`SELECT name, config, enabled_methods, discovered_methods, requested_access, access_applied_at
			 FROM mcp_connections WHERE id = $1`,
			[seededConnectorId],
		);
		expect(kept.rows).toHaveLength(1);
		expect(kept.rows[0].name).toBe('linear');
		expect(kept.rows[0].config.url).toBe('https://mcp.linear.app/mcp');
		// NULL enabled_methods is the load-bearing "no allowlist" state: every
		// connector that existed before this migration stays fully enabled.
		expect(kept.rows[0].enabled_methods).toBeNull();
		expect(kept.rows[0].discovered_methods).toBeNull();
		expect(kept.rows[0].requested_access).toBeNull();
		expect(kept.rows[0].access_applied_at).toBeNull();
	});

	it('stores a method catalog and an allowlist, and reads them back', async () => {
		await h.db.query(
			`UPDATE mcp_connections
			 SET discovered_methods = $1::jsonb,
			     enabled_methods = $2::jsonb,
			     methods_listed_at = now(),
			     requested_access = 'read'::connector_access,
			     access_applied_at = now()
			 WHERE id = $3`,
			[
				JSON.stringify([
					{ name: 'get_issue', read_only: true, inferred: false },
					{ name: 'save_issue', read_only: false, inferred: false },
				]),
				JSON.stringify(['get_issue']),
				seededConnectorId,
			],
		);

		const row = await h.db.query<{
			enabled_methods: string[];
			discovered_methods: { name: string; read_only: boolean }[];
			requested_access: string;
			methods_listed_at: string;
		}>(
			`SELECT enabled_methods, discovered_methods, requested_access::text AS requested_access,
			        methods_listed_at::text AS methods_listed_at
			 FROM mcp_connections WHERE id = $1`,
			[seededConnectorId],
		);
		expect(row.rows[0].enabled_methods).toEqual(['get_issue']);
		expect(row.rows[0].discovered_methods.map((m) => m.name)).toEqual(['get_issue', 'save_issue']);
		expect(row.rows[0].requested_access).toBe('read');
		expect(row.rows[0].methods_listed_at).not.toBeNull();
	});

	it('rejects an access value outside the enum', async () => {
		await expect(
			h.db.query(`UPDATE mcp_connections SET requested_access = 'admin'::connector_access`),
		).rejects.toThrow();
	});

	it('adds the partial index the restricted-connector lookup uses', async () => {
		const idx = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes
			 WHERE tablename = 'mcp_connections' AND indexname = 'idx_mcp_connections_restricted'`,
		);
		expect(idx.rows).toHaveLength(1);
	});
});
