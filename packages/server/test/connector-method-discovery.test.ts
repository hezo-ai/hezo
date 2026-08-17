import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { discoverConnectorMethods } from '../src/services/connectors/method-discovery';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';
import { startTestMcpHttpServer, type TestMcpServer } from './helpers/test-mcp-http-server';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let db: Db;
let deps: Parameters<typeof discoverConnectorMethods>[0];
let server: TestMcpServer;
let mcpUrl: string;

/**
 * A catalog that exercises both classification paths: `search_docs` and
 * `save_issue` are decided by the leading word, while `list_and_lock` carries an
 * explicit `readOnlyHint: false` that must beat the name.
 */
const TOOLS = [
	{ name: 'get_issue', description: 'Fetch an issue' },
	{ name: 'search_docs', description: 'Search the docs' },
	{ name: 'save_issue', description: 'Create or update an issue' },
	{
		name: 'list_and_lock',
		description: 'Lists, but takes a lock',
		annotations: { readOnlyHint: false },
	},
];

/**
 * Insert a connector pointed at the shared test MCP server. `extraColumns` maps
 * a column to a literal SQL expression (e.g. an enum cast), which keeps the
 * enum-valued seeds readable; anything needing a bound parameter is set with a
 * follow-up UPDATE in the test itself.
 */
async function seedConnector(extraColumns: Record<string, string> = {}): Promise<string> {
	const cols = ['name', 'kind', 'config', 'install_status', ...Object.keys(extraColumns)];
	const vals = ['$1', "'saas'", '$2::jsonb', "'installed'", ...Object.values(extraColumns)];
	const r = await db.query<{ id: string }>(
		`INSERT INTO mcp_connections (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id`,
		[`svc-${Math.random().toString(36).slice(2, 8)}`, JSON.stringify({ url: mcpUrl })],
	);
	return r.rows[0].id;
}

beforeAll(async () => {
	ctx = await createTestApp();
	db = ctx.db;
	deps = { db, masterKeyManager: ctx.masterKeyManager };
	server = await startTestMcpHttpServer({ tools: TOOLS });
	mcpUrl = `http://127.0.0.1:${server.port}/mcp`;
});

afterAll(async () => {
	await server.close();
	await safeClose(db);
});

describe('discoverConnectorMethods', () => {
	it('lists the server tools, classifies them, and caches the catalog', async () => {
		const id = await seedConnector();
		const result = await discoverConnectorMethods(deps, id);
		if (!result.ok) throw new Error(`discovery failed: ${result.reason}`);

		expect(result.methods.map((m) => m.name)).toEqual([
			'get_issue',
			'search_docs',
			'save_issue',
			'list_and_lock',
		]);
		// The declared hint beats the read-shaped name.
		const locked = result.methods.find((m) => m.name === 'list_and_lock');
		expect(locked?.readOnly).toBe(false);
		expect(locked?.inferred).toBe(false);
		// The heuristic decides the rest.
		expect(result.methods.find((m) => m.name === 'search_docs')?.readOnly).toBe(true);
		expect(result.methods.find((m) => m.name === 'save_issue')?.readOnly).toBe(false);

		const row = await db.query<{
			discovered_methods: { name: string }[];
			methods_listed_at: string | null;
			enabled_methods: string[] | null;
		}>(
			`SELECT discovered_methods, methods_listed_at::text AS methods_listed_at, enabled_methods
			 FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(row.rows[0].discovered_methods).toHaveLength(4);
		expect(row.rows[0].methods_listed_at).not.toBeNull();
		// Discovery alone must never restrict anything.
		expect(row.rows[0].enabled_methods).toBeNull();
		expect(result.appliedReadOnly).toBe(false);
	});

	it("applies an agent's read-only request once the methods are known", async () => {
		const id = await seedConnector({ requested_access: "'read'::connector_access" });
		const result = await discoverConnectorMethods(deps, id);
		expect(result.ok && result.appliedReadOnly).toBe(true);

		const row = await db.query<{ enabled_methods: string[]; access_applied_at: string | null }>(
			`SELECT enabled_methods, access_applied_at::text AS access_applied_at
			 FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(row.rows[0].enabled_methods).toEqual(['get_issue', 'search_docs']);
		expect(row.rows[0].access_applied_at).not.toBeNull();
	});

	it('never re-applies the request over an operator who widened the allowlist', async () => {
		const id = await seedConnector({ requested_access: "'read'::connector_access" });
		await discoverConnectorMethods(deps, id);

		// The operator decides one write method is fine after all.
		await db.query(`UPDATE mcp_connections SET enabled_methods = $1::jsonb WHERE id = $2`, [
			JSON.stringify(['get_issue', 'search_docs', 'save_issue']),
			id,
		]);

		const again = await discoverConnectorMethods(deps, id);
		expect(again.ok && again.appliedReadOnly).toBe(false);
		const row = await db.query<{ enabled_methods: string[] }>(
			`SELECT enabled_methods FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(row.rows[0].enabled_methods).toContain('save_issue');
	});

	it('leaves an operator-set allowlist alone even on a first discovery', async () => {
		// The connector was restricted before its methods were ever listed, so
		// there is no `access_applied_at` stamp to stop the request — the
		// "enabled_methods is already set" guard is what has to hold here.
		const id = await seedConnector({ requested_access: "'read'::connector_access" });
		await db.query(`UPDATE mcp_connections SET enabled_methods = $1::jsonb WHERE id = $2`, [
			JSON.stringify(['save_issue']),
			id,
		]);

		const result = await discoverConnectorMethods(deps, id);
		expect(result.ok && result.appliedReadOnly).toBe(false);
		const row = await db.query<{ enabled_methods: string[] }>(
			`SELECT enabled_methods FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(row.rows[0].enabled_methods).toEqual(['save_issue']);
	});

	it('refreshes the catalog when the server changes what it advertises', async () => {
		const id = await seedConnector();
		await discoverConnectorMethods(deps, id);

		const grown = await startTestMcpHttpServer({
			tools: [...TOOLS, { name: 'delete_issue', description: 'Delete an issue' }],
		});
		try {
			await db.query(`UPDATE mcp_connections SET config = $1::jsonb WHERE id = $2`, [
				JSON.stringify({ url: `http://127.0.0.1:${grown.port}/mcp` }),
				id,
			]);
			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok && result.methods.map((m) => m.name)).toContain('delete_issue');
		} finally {
			await grown.close();
		}
	});

	it('sends the decrypted api key to the server rather than a placeholder', async () => {
		const probe = await startTestMcpHttpServer({ tools: TOOLS });
		try {
			const secret = await db.query<{ id: string }>(
				`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
				 VALUES ($1, $2, 'api_token'::secret_category, '{127.0.0.1}')
				 RETURNING id`,
				[
					`MCP_PROBE_KEY_${Math.random().toString(36).slice(2, 8)}`.toUpperCase(),
					await encryptForTest('live-key-abc'),
				],
			);
			const id = await seedConnector();
			await db.query(
				`UPDATE mcp_connections
				 SET config = $1::jsonb, api_key_secret_id = $2, activated_at = now()
				 WHERE id = $3`,
				[JSON.stringify({ url: `http://127.0.0.1:${probe.port}/mcp` }), secret.rows[0].id, id],
			);

			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok).toBe(true);
			const auth = probe.requests[0]?.headers.authorization;
			expect(auth).toBe('Bearer live-key-abc');
		} finally {
			await probe.close();
		}
	});

	it('drops an unsubstitutable placeholder header rather than sending it verbatim', async () => {
		const probe = await startTestMcpHttpServer({ tools: TOOLS });
		try {
			const id = await seedConnector();
			await db.query(`UPDATE mcp_connections SET config = $1::jsonb WHERE id = $2`, [
				JSON.stringify({
					url: `http://127.0.0.1:${probe.port}/mcp`,
					headers: { 'X-Api-Key': '__HEZO_SECRET_SOMETHING__', 'X-Plain': 'kept' },
				}),
				id,
			]);

			await discoverConnectorMethods(deps, id);
			// The egress proxy that would substitute it is not in this path, so
			// sending it would authenticate as the literal placeholder string.
			expect(probe.requests[0]?.headers['x-api-key']).toBeUndefined();
			expect(probe.requests[0]?.headers['x-plain']).toBe('kept');
		} finally {
			await probe.close();
		}
	});

	it('reports probe_failed when the server rejects the handshake', async () => {
		const broken = await startTestMcpHttpServer({ failWithStatus: 500 });
		try {
			const id = await seedConnector();
			await db.query(`UPDATE mcp_connections SET config = $1::jsonb WHERE id = $2`, [
				JSON.stringify({ url: `http://127.0.0.1:${broken.port}/mcp` }),
				id,
			]);
			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe('probe_failed');
		} finally {
			await broken.close();
		}
	});

	it('reports auth_failed and records connector health when the server rejects the credential', async () => {
		// The incident shape: an expired OAuth grant answers 401 with an empty body,
		// so the MCP SDK's message ends at a bare "Error POSTing to endpoint:" and
		// says nothing about the token. The status is the only usable signal, and
		// reading `(e as Error).message` threw it away — leaving the operator with
		// an unactionable toast and the connector still reading as Connected.
		const unauthorized = await startTestMcpHttpServer({ failWithStatus: 401 });
		try {
			const id = await seedConnector();
			// Credentialed, matching the incident: the probe carries everything a run
			// would carry, so a 401 really is the stored grant being rejected.
			const secret = await db.query<{ id: string }>(
				`INSERT INTO secrets (name, encrypted_value) VALUES ($1, $2) RETURNING id`,
				[`TOK_${Math.random().toString(36).slice(2, 8)}`, await encryptForTest('stale-token')],
			);
			const conn = await db.query<{ id: string }>(
				`INSERT INTO oauth_connections
				   (provider, provider_account_id, provider_account_label, access_token_secret_id)
				 VALUES ('fake', $1, 'Fake', $2) RETURNING id`,
				[`acct-${Math.random().toString(36).slice(2, 8)}`, secret.rows[0].id],
			);
			await db.query(
				`UPDATE mcp_connections
				 SET config = $1::jsonb, oauth_connection_id = $2, activated_at = now()
				 WHERE id = $3`,
				[JSON.stringify({ url: `http://127.0.0.1:${unauthorized.port}/mcp` }), conn.rows[0].id, id],
			);
			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe('auth_failed');
				expect(result.detail).toContain('401');
			}
			// And the failure is recorded, so the banner lights up and the card
			// offers a reconnect rather than the knowledge dying in one toast.
			const row = await db.query<{ auth_error: string | null }>(
				`SELECT auth_error FROM mcp_connections WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].auth_error).toContain('401');
		} finally {
			await unauthorized.close();
		}
	});

	// The other half of the same rule. An uncredentialed row's 401 says the server
	// wants a credential, not that a stored one was rejected - so it is recorded as
	// probe evidence and must not light the "reconnect this" banner, which is for a
	// connection that worked and stopped.
	it('records an uncredentialed refusal as probe evidence, not as a rejected credential', async () => {
		const unauthorized = await startTestMcpHttpServer({ failWithStatus: 401 });
		try {
			const id = await seedConnector();
			await db.query(`UPDATE mcp_connections SET config = $1::jsonb WHERE id = $2`, [
				JSON.stringify({ url: `http://127.0.0.1:${unauthorized.port}/mcp` }),
				id,
			]);
			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok).toBe(false);

			const row = await db.query<{ auth_error: string | null; probe_error: string | null }>(
				`SELECT auth_error, probe_error FROM mcp_connections WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].probe_error).toBe('auth_required');
			expect(row.rows[0].auth_error).toBeNull();
		} finally {
			await unauthorized.close();
		}
	});

	it('does not refresh - or degrade - a connector whose token is still fresh', async () => {
		// Regression: the probe used to call `refreshConnection` unconditionally on
		// the assumption it no-ops for a fresh token. It does not - it has no expiry
		// check - so every "Refresh methods" click burned a provider round-trip, and
		// against a provider that rotates refresh tokens it rotated the grant each
		// time. Worse, when that gratuitous refresh failed, the connector was marked
		// degraded: a connector activated seconds earlier, with a perfectly good
		// token, reported as broken to the operator, to agents, and on the banner.
		const id = await seedConnector();
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ($1, $2) RETURNING id`,
			[`TOK_${Math.random().toString(36).slice(2, 8)}`, await encryptForTest('live-token')],
		);
		const refresh = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ($1, $2) RETURNING id`,
			[`REFRESH_${Math.random().toString(36).slice(2, 8)}`, await encryptForTest('refresh-token')],
		);
		// An hour of life left, and a refresh token present — the exact shape a
		// just-completed OAuth handshake leaves behind.
		const conn = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections
			   (provider, provider_account_id, provider_account_label,
			    access_token_secret_id, refresh_token_secret_id, expires_at)
			 VALUES ('fake', $1, 'Fake', $2, $3, now() + interval '1 hour')
			 RETURNING id`,
			[`acct-${Math.random().toString(36).slice(2, 8)}`, secret.rows[0].id, refresh.rows[0].id],
		);
		await db.query(
			`UPDATE mcp_connections SET oauth_connection_id = $1, activated_at = now() WHERE id = $2`,
			[conn.rows[0].id, id],
		);

		await discoverConnectorMethods(deps, id, 'manual');

		// No refresh function is registered in this suite, so had the probe tried to
		// refresh, the attempt would have recorded an auth error and degraded the row.
		const row = await db.query<{ auth_error: string | null }>(
			`SELECT auth_error FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(row.rows[0].auth_error).toBeNull();
	});

	it('stamps the handshake as evidence even when the server serves no tool catalog', async () => {
		// A server exposing only prompts or resources completes the handshake and
		// refuses `tools/list`. Gating a run on the catalog would exclude a whole
		// class of perfectly usable servers, so the evidence is `initialize`.
		const promptsOnly = await startTestMcpHttpServer({ toolsUnsupported: true });
		try {
			const id = await seedConnector();
			await db.query(`UPDATE mcp_connections SET config = $1::jsonb WHERE id = $2`, [
				JSON.stringify({ url: `http://127.0.0.1:${promptsOnly.port}/mcp` }),
				id,
			]);

			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe('probe_failed');
				expect(result.phase).toBe('catalog');
			}

			const row = await db.query<{
				probed_at: string | null;
				probe_error: string | null;
				methods_listed_at: string | null;
				discovered_methods: unknown;
			}>(
				`SELECT probed_at::text AS probed_at, probe_error::text AS probe_error,
				        methods_listed_at::text AS methods_listed_at, discovered_methods
				 FROM mcp_connections WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].probed_at).not.toBeNull();
			expect(row.rows[0].probe_error).toBeNull();
			// The catalog is untouched, so a previously-listed one is not wiped by a
			// server that has since stopped answering tools/list.
			expect(row.rows[0].methods_listed_at).toBeNull();
			expect(row.rows[0].discovered_methods).toBeNull();

			// And it reaches runs, which is the whole point.
			const { loadConnectorsForRun } = await import('../src/services/connectors/connections');
			const rows = await loadConnectorsForRun(db);
			expect(rows.some((r) => r.id === id)).toBe(true);
		} finally {
			await promptsOnly.close();
		}
	});

	it('records nothing about a credential the probe could not carry', async () => {
		// Finding (A): a `config.headers` placeholder is substituted by the egress
		// proxy at request time. `buildProbeHeaders` strips it rather than sending
		// the literal string, so the probe goes out with less than a run would and
		// its 401 is about the probe. Recording it would have made one "List
		// methods" click exclude a working connector permanently.
		const unauthorized = await startTestMcpHttpServer({ failWithStatus: 401 });
		try {
			const id = await seedConnector();
			await db.query(`UPDATE mcp_connections SET config = $1::jsonb WHERE id = $2`, [
				JSON.stringify({
					url: `http://127.0.0.1:${unauthorized.port}/mcp`,
					headers: { Authorization: 'Bearer __HEZO_SECRET_TRACKER_KEY__' },
				}),
				id,
			]);

			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe('auth_unverifiable');

			const row = await db.query<{
				auth_error: string | null;
				probed_at: string | null;
				probe_error: string | null;
			}>(
				`SELECT auth_error, probed_at::text AS probed_at, probe_error::text AS probe_error
				 FROM mcp_connections WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].auth_error).toBeNull();
			expect(row.rows[0].probe_error).toBeNull();
			expect(row.rows[0].probed_at).not.toBeNull();

			// The header is its own credential, so the connector keeps reaching runs.
			const { loadConnectorsForRun } = await import('../src/services/connectors/connections');
			expect((await loadConnectorsForRun(db)).some((r) => r.id === id)).toBe(true);
		} finally {
			await unauthorized.close();
		}
	});

	it('does not clear a stale auth_error on a success it reached without the credential', async () => {
		// The same rule read the other way. A probe that could not carry the row's
		// own credential has no standing to declare it healthy either.
		const open = await startTestMcpHttpServer({ tools: TOOLS });
		try {
			const id = await seedConnector();
			await db.query(
				`UPDATE mcp_connections SET config = $1::jsonb, auth_error = 'probe: HTTP 401' WHERE id = $2`,
				[
					JSON.stringify({
						url: `http://127.0.0.1:${open.port}/mcp`,
						headers: { 'X-Api-Key': '__HEZO_SECRET_TRACKER_KEY__' },
					}),
					id,
				],
			);

			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok).toBe(true);
			const row = await db.query<{ auth_error: string | null; probe_error: string | null }>(
				`SELECT auth_error, probe_error::text AS probe_error FROM mcp_connections WHERE id = $1`,
				[id],
			);
			expect(row.rows[0].auth_error).toBe('probe: HTTP 401');
			expect(row.rows[0].probe_error).toBeNull();
		} finally {
			await open.close();
		}
	});

	it('leaves no probe evidence on a row it never reached', async () => {
		// `locked`, `not_found` and `unsupported_kind` never contacted anything, so
		// stamping them would let those cases burn the sweep's pacing clock and
		// pass an unproven connector off as proven.
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ($1, 'enc', 'api_token'::secret_category, '{127.0.0.1}')
			 RETURNING id`,
			[`MCP_NOPROBE_${Math.random().toString(36).slice(2, 8)}`.toUpperCase()],
		);
		const id = await seedConnector();
		await db.query(
			`UPDATE mcp_connections SET api_key_secret_id = $1, activated_at = now() WHERE id = $2`,
			[secret.rows[0].id, id],
		);
		const lockedDeps = { db, masterKeyManager: { getKey: () => null } as never };
		expect((await discoverConnectorMethods(lockedDeps, id)).ok).toBe(false);

		const row = await db.query<{ probed_at: string | null }>(
			`SELECT probed_at::text AS probed_at FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(row.rows[0].probed_at).toBeNull();
	});

	it('reports not_found for an unknown connector', async () => {
		const result = await discoverConnectorMethods(deps, '00000000-0000-0000-0000-000000000000');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('not_found');
	});

	it('reports unsupported_kind for api and local connectors', async () => {
		const api = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('some-api', 'api', $1::jsonb, 'installed') RETURNING id`,
			[JSON.stringify({ base_url: 'https://api.example.com', allowed_hosts: ['api.example.com'] })],
		);
		const local = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('some-local', 'local', $1::jsonb, 'installed') RETURNING id`,
			[JSON.stringify({ command: '/usr/bin/srv' })],
		);
		for (const id of [api.rows[0].id, local.rows[0].id]) {
			const result = await discoverConnectorMethods(deps, id);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe('unsupported_kind');
		}
	});

	it('reports not_connected for a revoked connector', async () => {
		const id = await seedConnector();
		await db.query(`UPDATE mcp_connections SET revoked_at = now() WHERE id = $1`, [id]);
		const result = await discoverConnectorMethods(deps, id);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('not_connected');
	});

	it('reports locked, without throwing, when the master key is unavailable', async () => {
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ($1, 'enc', 'api_token'::secret_category, '{127.0.0.1}')
			 RETURNING id`,
			[`MCP_LOCKED_${Math.random().toString(36).slice(2, 8)}`.toUpperCase()],
		);
		const id = await seedConnector();
		await db.query(
			`UPDATE mcp_connections SET api_key_secret_id = $1, activated_at = now() WHERE id = $2`,
			[secret.rows[0].id, id],
		);

		// Discovery runs off the connect path, which must never fail because the
		// instance happens to be locked — it degrades to "try again later".
		const lockedDeps = { db, masterKeyManager: { getKey: () => null } as never };
		const result = await discoverConnectorMethods(lockedDeps, id);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe('locked');
	});
});

/** Encrypt a value with the test instance's master key, as the vault would. */
async function encryptForTest(value: string): Promise<string> {
	const key = ctx.masterKeyManager.getKey();
	if (!key) throw new Error('test master key unavailable');
	const { encrypt } = await import('../src/crypto/encryption');
	return encrypt(value, key);
}
