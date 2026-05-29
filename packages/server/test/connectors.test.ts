import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, DocumentType, McpConnectionKind, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import {
	createOrFetchConnector,
	getConnector,
	markActive,
	markFailed,
	markRevoked,
	statusOf,
} from '../src/services/connectors/lifecycle';
import { registerClient } from '../src/services/oauth/dcr';
import {
	discoverMcpAuthorization,
	probeForProtectedResourceMetadata,
} from '../src/services/oauth/prm-discovery';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, mintAgentToken } from './helpers/app';
import { type FakeMcpServer, startFakeMcpServer } from './helpers/fake-mcp-server';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let captainId: string;
let captainAgentToken: string;
let fake: FakeMcpServer;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Connectors Test Co', template_id: typeId }),
	});
	teamId = (await teamRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	captainId = agents.find((a) => a.slug === 'captain')!.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Test Project',
		description: 'x',
	});
	projectId = (await projectRes.json()).data.id;

	fake = await startFakeMcpServer();
});

afterAll(async () => {
	await fake.close();
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM agent_wakeup_requests');
	await db.query('DELETE FROM mcp_connections WHERE team_id = $1', [teamId]);
	await db.query(`DELETE FROM documents WHERE team_id = $1 AND type = 'mcp_skill'::document_type`, [
		teamId,
	]);
});

describe('PRM + AS discovery', () => {
	it('probes the MCP server and extracts resource_metadata URL', async () => {
		const prmUrl = await probeForProtectedResourceMetadata(`${fake.url}/mcp`);
		expect(prmUrl).toBe(`${fake.url}/.well-known/oauth-protected-resource`);
	});

	it('walks PRM → AS metadata and returns endpoints', async () => {
		const discovery = await discoverMcpAuthorization(`${fake.url}/mcp`);
		expect(discovery.authorizationServerUrl).toBe(fake.url);
		expect(discovery.asMetadata.authorization_endpoint).toBe(`${fake.url}/authorize`);
		expect(discovery.asMetadata.token_endpoint).toBe(`${fake.url}/token`);
		expect(discovery.asMetadata.registration_endpoint).toBe(`${fake.url}/register`);
	});
});

describe('DCR (RFC 7591)', () => {
	it('registers a public client and returns a client_id', async () => {
		const result = await registerClient({
			registrationEndpoint: `${fake.url}/register`,
			redirectUri: 'http://localhost:3100/api/oauth/mcp-callback',
			clientName: 'Hezo Test',
		});
		expect(result.clientId).toMatch(/^fake_/);
	});

	it('errors out when the AS rejects registration', async () => {
		const broken = await startFakeMcpServer({ rejectDcr: true });
		try {
			await expect(
				registerClient({
					registrationEndpoint: `${broken.url}/register`,
					redirectUri: 'http://localhost:3100/api/oauth/mcp-callback',
				}),
			).rejects.toThrow(/DCR registration failed/);
		} finally {
			await broken.close();
		}
	});
});

describe('Connector lifecycle helpers', () => {
	it('creates pending, transitions to active, then revoked', async () => {
		const { row: created, alreadyExisted } = await createOrFetchConnector(db, {
			teamId,
			name: 'datocms',
			displayName: 'DatoCMS',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
		});
		expect(alreadyExisted).toBe(false);
		expect(statusOf(created)).toBe('pending');

		// Create a fake oauth_connection row to point to.
		const secretRes = await db.query<{ id: string }>(
			`INSERT INTO secrets (team_id, name, encrypted_value)
			 VALUES ($1, 'TEST_TOKEN_FAKE', 'enc') RETURNING id`,
			[teamId],
		);
		const ocRes = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections
			 (team_id, provider, provider_account_id, provider_account_label, access_token_secret_id)
			 VALUES ($1, 'mcp:test', 'acct1', 'Test', $2) RETURNING id`,
			[teamId, secretRes.rows[0].id],
		);

		const activated = await markActive(db, created.id, ocRes.rows[0].id);
		expect(activated).not.toBeNull();
		expect(statusOf(activated!)).toBe('active');

		const revoked = await markRevoked(db, created.id);
		expect(statusOf(revoked!)).toBe('revoked');
	});

	it('createOrFetchConnector is idempotent on (team, name)', async () => {
		const first = await createOrFetchConnector(db, {
			teamId,
			name: 'linear',
			displayName: 'Linear',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
		});
		const second = await createOrFetchConnector(db, {
			teamId,
			name: 'linear',
			displayName: 'Linear',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
		});
		expect(second.alreadyExisted).toBe(true);
		expect(second.row.id).toBe(first.row.id);
	});

	it('markFailed records the reason without flipping to active', async () => {
		const { row } = await createOrFetchConnector(db, {
			teamId,
			name: 'sentry',
			displayName: 'Sentry',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
		});
		const failed = await markFailed(db, row.id, 'discovery: boom');
		expect(failed?.auth_error).toBe('discovery: boom');
		expect(statusOf(failed!)).toBe('failed');
	});
});

describe('OAuth callback route (end-to-end against fake AS)', () => {
	let taskId: string;
	let connectorId: string;

	beforeEach(async () => {
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'CON-' || (COALESCE(MAX(number), 0) + 1)::text, 'Test'
			 FROM tasks WHERE project_id = $2
			 RETURNING id`,
			[teamId, projectId, captainId],
		);
		taskId = taskRes.rows[0].id;
		const minted = await mintAgentToken(db, masterKeyManager, captainId, teamId, taskId);
		captainAgentToken = minted.token;

		const { row } = await createOrFetchConnector(db, {
			teamId,
			name: 'datocms',
			displayName: 'DatoCMS',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
			createdByTaskId: taskId,
		});
		connectorId = row.id;
	});

	it('auth-start performs DCR and returns an authorize URL', async () => {
		const res = await app.request(`/api/teams/${teamId}/connectors/${connectorId}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: { auth_url: string } };
		expect(data.auth_url).toContain(`${fake.url}/authorize`);
		expect(data.auth_url).toContain('client_id=fake_');
		expect(data.auth_url).toContain('code_challenge=');

		// DCR client_id is persisted in connector.config.dcr.
		const connector = await getConnector(db, connectorId);
		const config = connector!.config as { dcr?: { client_id: string } };
		expect(config.dcr?.client_id).toBe(fake.lastClientId());
	});

	it('callback completes the flow: stores token, marks active, fires wakeup', async () => {
		// Drive auth-start to get a real authorize URL.
		const startRes = await app.request(
			`/api/teams/${teamId}/connectors/${connectorId}/auth-start`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: '{}',
			},
		);
		const { data: startData } = (await startRes.json()) as { data: { auth_url: string } };

		// Follow the authorize URL by hand — the fake AS auto-approves and would
		// redirect to the redirect_uri with `code` + `state`. We capture those
		// params, then drive our callback handler directly.
		const authorizeRes = await fetch(startData.auth_url, { redirect: 'manual' });
		expect(authorizeRes.status).toBe(302);
		const location = authorizeRes.headers.get('location')!;
		const locUrl = new URL(location);
		const code = locUrl.searchParams.get('code')!;
		const state = locUrl.searchParams.get('state')!;

		// Drive the callback.
		const cbRes = await app.request(
			`/api/oauth/mcp-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
		);
		expect(cbRes.status).toBe(200);
		const html = await cbRes.text();
		expect(html).toContain('OAuth connection complete');

		// Connector flipped to active with oauth_connection_id set.
		const connector = await getConnector(db, connectorId);
		expect(connector?.oauth_connection_id).toBeTruthy();
		expect(connector?.activated_at).toBeTruthy();
		expect(statusOf(connector!)).toBe('active');

		// Secret row landed in vault.
		const secretRow = await db.query<{ name: string }>(
			`SELECT s.name FROM oauth_connections oc
			 JOIN secrets s ON s.id = oc.access_token_secret_id
			 WHERE oc.id = $1`,
			[connector!.oauth_connection_id],
		);
		expect(secretRow.rows[0].name).toMatch(/^OAUTH_MCP_/);

		// CredentialProvided wakeup fired on the calling task's assignee.
		const wakeup = await db.query<{ source: string; payload: Record<string, unknown> }>(
			`SELECT source::text AS source, payload FROM agent_wakeup_requests
			 WHERE team_id = $1 AND member_id = $2
			   AND source = 'credential_provided'::wakeup_source`,
			[teamId, captainId],
		);
		expect(wakeup.rows.length).toBeGreaterThan(0);
		expect(wakeup.rows[0].source).toBe(WakeupSource.CredentialProvided);
		expect(wakeup.rows[0].payload.connector_id).toBe(connectorId);
	});

	it('callback fails with exchange error when the AS rejects the code', async () => {
		const broken = await startFakeMcpServer({ rejectExchange: true });
		try {
			const { row: brokenConn } = await createOrFetchConnector(db, {
				teamId,
				name: 'broken',
				displayName: 'Broken',
				mcpUrl: `${broken.url}/mcp`,
				mcpTransport: 'http',
				createdByTaskId: taskId,
			});
			const startRes = await app.request(
				`/api/teams/${teamId}/connectors/${brokenConn.id}/auth-start`,
				{
					method: 'POST',
					headers: { ...authHeader(token), 'Content-Type': 'application/json' },
					body: '{}',
				},
			);
			const { data } = (await startRes.json()) as { data: { auth_url: string } };
			const authorizeRes = await fetch(data.auth_url, { redirect: 'manual' });
			const location = authorizeRes.headers.get('location')!;
			const locUrl = new URL(location);
			const code = locUrl.searchParams.get('code')!;
			const state = locUrl.searchParams.get('state')!;

			const cbRes = await app.request(
				`/api/oauth/mcp-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
			);
			expect(cbRes.status).toBe(200);
			const html = await cbRes.text();
			expect(html).toContain('exchange_failed');

			const connector = await getConnector(db, brokenConn.id);
			expect(connector?.auth_error).toContain('exchange:');
			expect(statusOf(connector!)).toBe('failed');
		} finally {
			await broken.close();
		}
	});
});

describe('register_connector MCP tool', () => {
	it('creates a pending connector + posts a connect_required comment', async () => {
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'TAG-' || (COALESCE(MAX(number), 0) + 1)::text, 'agent triggers MCP add'
			 FROM tasks WHERE project_id = $2
			 RETURNING id`,
			[teamId, projectId, captainId],
		);
		const tId = taskRes.rows[0].id;
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			tId,
		);

		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'register_connector',
					arguments: {
						team_id: teamId,
						task_id: tId,
						display_name: 'DatoCMS',
						mcp_url: `${fake.url}/mcp`,
						mcp_transport: 'http',
						provider_id: 'datocms',
					},
				},
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ text: string }> };
		};
		const payload = JSON.parse(body.result.content[0].text) as {
			connector_id: string;
			status: string;
			comment_id: string;
		};
		expect(payload.status).toBe('pending');
		expect(payload.connector_id).toBeTruthy();
		expect(payload.comment_id).toBeTruthy();

		// Comment is connect_required with the connector_id reference.
		const comment = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments WHERE id = $1`,
			[payload.comment_id],
		);
		expect(comment.rows[0].content.connector_id).toBe(payload.connector_id);
		expect(comment.rows[0].content.display_name).toBe('DatoCMS');

		// Comment was posted on the calling task.
		const inserted = await db.query(
			`SELECT id FROM task_comments
			 WHERE task_id = $1 AND content_type = 'connect_required'::comment_content_type`,
			[tId],
		);
		expect(inserted.rows.length).toBe(1);
	});

	it('is idempotent: calling twice returns the same connector + reuses the comment', async () => {
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'IDP-' || (COALESCE(MAX(number), 0) + 1)::text, 'idem'
			 FROM tasks WHERE project_id = $2
			 RETURNING id`,
			[teamId, projectId, captainId],
		);
		const tId = taskRes.rows[0].id;
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			tId,
		);

		const call = async () => {
			const res = await app.request('/mcp', {
				method: 'POST',
				headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'register_connector',
						arguments: {
							team_id: teamId,
							task_id: tId,
							display_name: 'Linear',
							mcp_url: `${fake.url}/mcp`,
							mcp_transport: 'http',
							provider_id: 'linear',
						},
					},
				}),
			});
			const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
			return JSON.parse(body.result.content[0].text) as {
				connector_id: string;
				comment_id: string;
				reused: boolean;
			};
		};
		const first = await call();
		const second = await call();
		expect(second.connector_id).toBe(first.connector_id);
		expect(second.comment_id).toBe(first.comment_id);
		expect(second.reused).toBe(true);
	});
});

describe('fetch_skill_file MCP tool', () => {
	it('fetches a URL and stores it as an mcp_skill document', async () => {
		// Stand up a tiny HTTP server to serve the skill content.
		const { createServer } = await import('node:http');
		const skillBody = '# DatoCMS Skill\n\nUse the DatoCMS MCP via `register_connector`.';
		const server = createServer((req, res) => {
			res.setHeader('content-type', 'text/markdown');
			res.end(skillBody);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const skillPort = (server.address() as { port: number }).port;
		const skillUrl = `http://127.0.0.1:${skillPort}/skill.md`;

		try {
			const taskRes = await db.query<{ id: string }>(
				`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
				 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'SKL-' || (COALESCE(MAX(number), 0) + 1)::text, 'skill'
				 FROM tasks WHERE project_id = $2
				 RETURNING id`,
				[teamId, projectId, captainId],
			);
			const tId = taskRes.rows[0].id;
			const { token: agentToken } = await mintAgentToken(
				db,
				masterKeyManager,
				captainId,
				teamId,
				tId,
			);

			const res = await app.request('/mcp', {
				method: 'POST',
				headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: {
						name: 'fetch_skill_file',
						arguments: { team_id: teamId, url: skillUrl, title: 'DatoCMS Skill' },
					},
				}),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
			const payload = JSON.parse(body.result.content[0].text) as {
				doc_id: string;
				slug: string;
				size_bytes: number;
			};
			expect(payload.size_bytes).toBe(skillBody.length);

			const doc = await db.query<{ content: string; type: string }>(
				`SELECT content, type::text AS type FROM documents WHERE id = $1`,
				[payload.doc_id],
			);
			expect(doc.rows[0].type).toBe(DocumentType.McpSkill);
			expect(doc.rows[0].content).toBe(skillBody);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it('rejects non-http(s) URLs', async () => {
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'BAD-' || (COALESCE(MAX(number), 0) + 1)::text, 'bad url'
			 FROM tasks WHERE project_id = $2
			 RETURNING id`,
			[teamId, projectId, captainId],
		);
		const tId = taskRes.rows[0].id;
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			tId,
		);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'fetch_skill_file',
					arguments: { team_id: teamId, url: 'file:///etc/passwd' },
				},
			}),
		});
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		const payload = JSON.parse(body.result.content[0].text) as { error?: string };
		expect(payload.error).toMatch(/Only http\/https/);
	});
});

describe('loadMcpConnectionsForRun excludes pending/revoked', () => {
	it('only returns active or operator-created connectors', async () => {
		// Pending connector created via our flow — should be excluded (it has
		// a created_by_task_id, no oauth_connection_id yet, kind='saas').
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'EXC-' || (COALESCE(MAX(number), 0) + 1)::text, 'filter'
			 FROM tasks WHERE project_id = $2
			 RETURNING id`,
			[teamId, projectId, captainId],
		);
		await createOrFetchConnector(db, {
			teamId,
			name: 'pending',
			displayName: 'Pending',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
			createdByTaskId: taskRes.rows[0].id,
		});
		// A row similar to operator-created MCP (no created_by_task_id, no oauth) —
		// included in the result so existing behavior for public MCPs is preserved.
		await db.query(
			`INSERT INTO mcp_connections (team_id, name, kind, config, install_status)
			 VALUES ($1, 'operator', $2::mcp_connection_kind, '{"url": "https://public.example/mcp"}'::jsonb, 'installed')`,
			[teamId, McpConnectionKind.Saas],
		);
		const { loadMcpConnectionsForRun } = await import('../src/services/mcp-connections');
		const rows = await loadMcpConnectionsForRun(db, teamId, projectId);
		expect(rows.find((r) => r.name === 'operator')).toBeTruthy();
		expect(rows.find((r) => r.name === 'pending')).toBeUndefined();
	});
});

// Importing CommentContentType keeps the symbol used so test isolation imports
// are obvious; it also confirms shared enum compiles with the new value.
expect(CommentContentType.ConnectRequired).toBe('connect_required');
