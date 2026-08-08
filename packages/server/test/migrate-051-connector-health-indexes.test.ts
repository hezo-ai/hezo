import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '051_connector_health_indexes.sql';

const EXPECTED_INDEXES = ['idx_oauth_connections_refreshable', 'idx_mcp_connections_degraded'];

describe('051_connector_health_indexes migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;
	let connectionId: string;
	let degradedConnectorId: string;
	let healthyConnectorId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema before 051

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme', 'acme', 'AC') RETURNING id`,
			[team.rows[0].id],
		);
		projectId = project.rows[0].id;

		const secret = await h.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ('TOK', 'enc') RETURNING id`,
		);
		const refresh = await h.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ('REFRESH', 'enc') RETURNING id`,
		);
		const conn = await h.db.query<{ id: string }>(
			`INSERT INTO oauth_connections
			   (provider, provider_account_id, provider_account_label,
			    access_token_secret_id, refresh_token_secret_id, expires_at)
			 VALUES ('ibkr', 'acct-1', 'Interactive Brokers', $1, $2, now() - interval '1 hour')
			 RETURNING id`,
			[secret.rows[0].id, refresh.rows[0].id],
		);
		connectionId = conn.rows[0].id;

		// The row the banner exists for: connected once, credential since rejected.
		const degraded = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections
			   (name, kind, project_id, oauth_connection_id, activated_at, auth_error)
			 VALUES ('ibkr', 'saas'::mcp_connection_kind, $1, $2, now(),
			         'token refresh: token endpoint error: invalid_grant')
			 RETURNING id`,
			[projectId, connectionId],
		);
		degradedConnectorId = degraded.rows[0].id;

		const healthy = await h.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, project_id, activated_at)
			 VALUES ('linear', 'saas'::mcp_connection_kind, $1, now()) RETURNING id`,
			[projectId],
		);
		healthyConnectorId = healthy.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates both connector-health indexes', async () => {
		const r = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])`,
			[EXPECTED_INDEXES],
		);
		expect(r.rows.map((row) => row.indexname).sort()).toEqual([...EXPECTED_INDEXES].sort());
	});

	it('keeps the refresh index partial to connections that can actually refresh', async () => {
		// A connection with no refresh token can never be a sweep candidate, so
		// carrying it in the index would only grow the working set.
		const r = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_oauth_connections_refreshable'`,
		);
		expect(r.rows[0].indexdef.toLowerCase()).toContain('where');
		expect(r.rows[0].indexdef).toContain('refresh_token_secret_id');
	});

	it('keeps the degraded index partial to broken rows', async () => {
		const def = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_mcp_connections_degraded'`,
		);
		expect(def.rows[0].indexdef.toLowerCase()).toContain('where');
		expect(def.rows[0].indexdef).toContain('auth_error');
	});

	it('serves the queries the indexes exist for', async () => {
		// The sweep's candidate query, including the ORDER BY + LIMIT the index adds.
		const candidates = await h.db.query<{ id: string }>(
			`SELECT id FROM oauth_connections
			 WHERE expires_at IS NOT NULL AND expires_at <= now()
			   AND refresh_token_secret_id IS NOT NULL
			 ORDER BY expires_at ASC LIMIT 25`,
		);
		expect(candidates.rows.map((r) => r.id)).toContain(connectionId);

		// The banner's query: the degraded row, and only it.
		const broken = await h.db.query<{ id: string }>(
			`SELECT id FROM mcp_connections
			 WHERE (project_id = $1 OR project_id IS NULL)
			   AND revoked_at IS NULL AND activated_at IS NOT NULL AND auth_error IS NOT NULL`,
			[projectId],
		);
		expect(broken.rows.map((r) => r.id)).toEqual([degradedConnectorId]);
	});

	it('preserves pre-existing connector and connection rows', async () => {
		const conn = await h.db.query<{ expires_at: Date | null }>(
			`SELECT expires_at FROM oauth_connections WHERE id = $1`,
			[connectionId],
		);
		expect(conn.rows.length).toBe(1);
		expect(conn.rows[0].expires_at).not.toBeNull();

		const connectors = await h.db.query<{ id: string; name: string; auth_error: string | null }>(
			`SELECT id, name, auth_error FROM mcp_connections WHERE id = ANY($1::uuid[]) ORDER BY name`,
			[[degradedConnectorId, healthyConnectorId]],
		);
		expect(connectors.rows.map((r) => r.name)).toEqual(['ibkr', 'linear']);
		expect(connectors.rows[0].auth_error).toContain('invalid_grant');
		expect(connectors.rows[1].auth_error).toBeNull();
	});
});
