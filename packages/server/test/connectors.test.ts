import { CommentContentType, ConnectorTransport, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
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
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';
import { type FakeMcpServer, startFakeMcpServer } from './helpers/fake-mcp-server';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let teamSlug: string;
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
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Connectors Test Co', template_id: typeId });
	const teamData = (await teamRes.json()).data;
	teamId = teamData.id;
	teamSlug = teamData.slug;

	projectSlug = (await (await createTestProject(db, teamId, { name: 'Setup Project' })).json()).data
		.slug;
	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
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
	await db.query('DELETE FROM mcp_connections');
	await db.query('DELETE FROM skills');
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

	it('falls back to well-known PRM when 401 has no resource_metadata hint (DatoCMS shape)', async () => {
		const realistic = await startFakeMcpServer({ omitWwwAuthenticateResourceMetadata: true });
		try {
			const prmUrl = await probeForProtectedResourceMetadata(`${realistic.url}/mcp`);
			expect(prmUrl).toBe(`${realistic.url}/.well-known/oauth-protected-resource`);

			const discovery = await discoverMcpAuthorization(`${realistic.url}/mcp`);
			expect(discovery.authorizationServerUrl).toBe(realistic.url);
			expect(discovery.asMetadata.registration_endpoint).toBe(`${realistic.url}/register`);
		} finally {
			await realistic.close();
		}
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
			name: 'datocms',
			displayName: 'DatoCMS',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
		});
		expect(alreadyExisted).toBe(false);
		expect(statusOf(created)).toBe('pending');

		// Create a fake oauth_connection row to point to.
		const secretRes = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value)
			 VALUES ('TEST_TOKEN_FAKE', 'enc') RETURNING id`,
		);
		const ocRes = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections
			 (provider, provider_account_id, provider_account_label, access_token_secret_id)
			 VALUES ('mcp:test', 'acct1', 'Test', $1) RETURNING id`,
			[secretRes.rows[0].id],
		);

		const activated = await markActive(db, created.id, ocRes.rows[0].id);
		expect(activated).not.toBeNull();
		expect(statusOf(activated!)).toBe('active');

		const revoked = await markRevoked(db, created.id);
		expect(statusOf(revoked!)).toBe('revoked');
	});

	it('createOrFetchConnector is idempotent on name', async () => {
		const first = await createOrFetchConnector(db, {
			name: 'linear',
			displayName: 'Linear',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
		});
		const second = await createOrFetchConnector(db, {
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
			name: 'datocms',
			displayName: 'DatoCMS',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
			createdByTaskId: taskId,
		});
		connectorId = row.id;
	});

	it('auth-start performs DCR and returns an authorize URL', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: connectorId }),
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
		const startRes = await app.request(`/api/projects/${projectSlug}/auth-start`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ connector_id: connectorId }),
		});
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
				name: 'broken',
				displayName: 'Broken',
				mcpUrl: `${broken.url}/mcp`,
				mcpTransport: 'http',
				createdByTaskId: taskId,
			});
			const startRes = await app.request(`/api/projects/${projectSlug}/auth-start`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ connector_id: brokenConn.id }),
			});
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
						project: projectId,
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
							project: projectId,
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

	it('registers an OAuth REST-API connector with a preset provider persisted in config', async () => {
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'YTB-' || (COALESCE(MAX(number), 0) + 1)::text, 'upload recap to youtube'
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
						project: projectId,
						task_id: tId,
						kind: 'api',
						display_name: 'Google / YouTube',
						base_url: 'https://www.googleapis.com/youtube/v3',
						allowed_hosts: ['*.googleapis.com'],
						oauth_provider_id: 'google-youtube',
					},
				},
			}),
		});
		expect(res.status).toBe(200);
		const payload = JSON.parse(
			((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]
				.text,
		) as { connector_id: string; status: string; comment_id: string };
		expect(payload.status).toBe('pending');
		expect(payload.comment_id).toBeTruthy();

		const row = await db.query<{ kind: string; config: Record<string, unknown> }>(
			`SELECT kind::text AS kind, config FROM mcp_connections WHERE id = $1`,
			[payload.connector_id],
		);
		expect(row.rows[0].kind).toBe('api');
		expect(row.rows[0].config.oauth_provider_id).toBe('google-youtube');
		expect(row.rows[0].config.base_url).toBe('https://www.googleapis.com/youtube/v3');
		expect(row.rows[0].config.allowed_hosts).toEqual(['*.googleapis.com']);
	});

	it('rejects an unknown oauth_provider_id', async () => {
		const taskRes = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'BAD-' || (COALESCE(MAX(number), 0) + 1)::text, 'bad provider'
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
						project: projectId,
						task_id: tId,
						kind: 'api',
						display_name: 'Bogus',
						base_url: 'https://api.bogus.example/v1',
						allowed_hosts: ['api.bogus.example'],
						oauth_provider_id: 'not-a-real-provider',
					},
				},
			}),
		});
		const payload = JSON.parse(
			((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]
				.text,
		) as { error?: string };
		expect(payload.error).toContain('unknown oauth_provider_id');
	});

	it('surfaces the originating task identifier + title on the project connectors list', async () => {
		const taskRes = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title)
			 SELECT $1, $2, $3, COALESCE(MAX(number), 0) + 1, 'LNK-' || (COALESCE(MAX(number), 0) + 1)::text, 'connect linear'
			 FROM tasks WHERE project_id = $2
			 RETURNING id, identifier`,
			[teamId, projectId, captainId],
		);
		const tId = taskRes.rows[0].id;
		const identifier = taskRes.rows[0].identifier;
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			tId,
		);

		await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: {
					name: 'register_connector',
					arguments: {
						project: projectId,
						task_id: tId,
						display_name: 'Linear',
						mcp_url: `${fake.url}/mcp`,
						provider_id: 'linear',
					},
				},
			}),
		});

		const slugRow = await db.query<{ slug: string }>(`SELECT slug FROM projects WHERE id = $1`, [
			projectId,
		]);
		const listRes = await app.request(`/api/projects/${slugRow.rows[0].slug}/connectors`, {
			headers: authHeader(token),
		});
		const rows = (await listRes.json()).data as Array<{
			name: string;
			created_by_task_identifier: string | null;
			created_by_task_title: string | null;
		}>;
		const linear = rows.find((r) => r.name === 'linear');
		expect(linear?.created_by_task_identifier).toBe(identifier.toLowerCase());
		expect(linear?.created_by_task_title).toBe('connect linear');
	});
});

describe('fetch_skill_file MCP tool', () => {
	it('fetches a URL and stores it as a global auto_load skill', async () => {
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
						arguments: { project: projectId, url: skillUrl, title: 'DatoCMS Skill' },
					},
				}),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
			const payload = JSON.parse(body.result.content[0].text) as {
				skill_id: string;
				slug: string;
				size_bytes: number;
			};
			expect(payload.size_bytes).toBe(skillBody.length);

			const skill = await db.query<{ content: string; auto_load: boolean; source_url: string }>(
				`SELECT content, auto_load, source_url FROM skills WHERE id = $1`,
				[payload.skill_id],
			);
			expect(skill.rows[0].auto_load).toBe(true);
			expect(skill.rows[0].content).toBe(skillBody);
			expect(skill.rows[0].source_url).toBe(skillUrl);
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
					arguments: { project: projectId, url: 'file:///etc/passwd' },
				},
			}),
		});
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		const payload = JSON.parse(body.result.content[0].text) as { error?: string };
		expect(payload.error).toMatch(/Only http\/https/);
	});
});

describe('loadConnectorsForRun requires evidence a connector can be reached', () => {
	/** The gate's one rule, per row: does a run get this connector, and why. */
	async function seed(name: string, columns: string, values: string): Promise<void> {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status${columns})
			 VALUES ($1, 'saas', $2::jsonb, 'installed'${values})`,
			[name, JSON.stringify({ url: `https://${name}.example/mcp` })],
		);
	}

	it('injects a hosted connector only on proof it answers, or on a credential it carries', async () => {
		// Never probed. This is the population the change is about: it used to be
		// handed to every run, 401 at handshake inside the container where nothing
		// here could see it, and be handed over again forever.
		await seed('unprobed', '', '');
		// Probed, and it answered without a credential: genuinely public.
		await seed('verified-public', ', probed_at', ', now()');
		// Probed, and it demanded one.
		await seed(
			'refused',
			', probed_at, probe_error',
			", now(), 'auth_required'::connector_probe_error",
		);
		// Authenticated by an operator-configured placeholder the egress proxy
		// substitutes. Unprobeable from this side - the probe cannot substitute it -
		// so the credential itself is the evidence.
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('header-auth', 'saas', $1::jsonb, 'installed')`,
			[
				JSON.stringify({
					url: 'https://header-auth.example/mcp',
					headers: { Authorization: 'Bearer __HEZO_SECRET_TRACKER__' },
				}),
			],
		);
		await seed('revoked', ', probed_at, revoked_at', ', now(), now()');

		const { loadConnectorsForRun } = await import('../src/services/connectors/connections');
		const names = (await loadConnectorsForRun(db)).map((r) => r.name);

		expect(names).toContain('verified-public');
		expect(names).toContain('header-auth');
		expect(names).not.toContain('unprobed');
		expect(names).not.toContain('refused');
		expect(names).not.toContain('revoked');
	});

	it('scopes to the run project (own + global) and a project connector shadows a global one', async () => {
		const { loadConnectorsForRun } = await import('../src/services/connectors/connections');
		// A second project (its own team — one project per team) whose connector
		// must never appear for our project.
		const otherTeam = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Other Run Team', 'other-run-team') RETURNING id`,
		);
		const otherProject = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, 'Other', 'other-run', 'OTHR') RETURNING id`,
			[otherTeam.rows[0].id],
		);
		// All probed, so scoping is the only thing under test here.
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, probed_at)
			 VALUES ('other-only', 'saas', '{"url":"https://other/mcp"}'::jsonb, 'installed', $1, now())`,
			[otherProject.rows[0].id],
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, probed_at)
			 VALUES ('shared', 'saas', '{"url":"https://global/mcp"}'::jsonb, 'installed', NULL, now())`,
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, probed_at)
			 VALUES ('shared', 'saas', '{"url":"https://project/mcp"}'::jsonb, 'installed', $1, now())`,
			[projectId],
		);
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, probed_at)
			 VALUES ('global-visible', 'saas', '{"url":"https://gv/mcp"}'::jsonb, 'installed', NULL, now())`,
		);

		const rows = await loadConnectorsForRun(db, projectId);
		expect(rows.find((r) => r.name === 'other-only')).toBeUndefined();
		expect(rows.find((r) => r.name === 'global-visible')).toBeTruthy();
		const shared = rows.filter((r) => r.name === 'shared');
		expect(shared).toHaveLength(1);
		expect((shared[0].config as { url: string }).url).toBe('https://project/mcp');
	});
});

// Importing CommentContentType keeps the symbol used so test isolation imports
// are obvious; it also confirms shared enum compiles with the new value.
expect(CommentContentType.ConnectRequired).toBe('connect_required');

/**
 * The banner's data source. It is its own endpoint rather than a filter over the
 * paginated connectors list because whether an operator learns a connector died
 * must not depend on which page its row landed on. It reports only the
 * working-to-broken case: a connector that never finished its first connect is a
 * setup step the operator already knows about, and banner-ing it would turn the
 * warning into permanent furniture.
 */
describe('GET /projects/:projectId/connectors/health', () => {
	async function health(): Promise<{ degraded: { id: string; name: string }[]; count: number }> {
		const res = await app.request(`/api/projects/${projectSlug}/connectors/health`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		return (await res.json()).data;
	}

	it('reports nothing while every connector is healthy', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'health-ok',
			displayName: 'Healthy',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
			projectId: await projectIdOf(projectSlug),
		});
		await db.query(`UPDATE mcp_connections SET activated_at = now() WHERE id = $1`, [row.id]);

		const body = await health();
		expect(body.count).toBe(0);
		expect(body.degraded).toEqual([]);
	});

	it('names a connector that was working and has stopped', async () => {
		const { row } = await createOrFetchConnector(db, {
			name: 'health-broken',
			displayName: 'Broken',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
			projectId: await projectIdOf(projectSlug),
		});
		await db.query(
			`UPDATE mcp_connections SET activated_at = now(), auth_error = $1 WHERE id = $2`,
			['token refresh: token endpoint error: invalid_grant', row.id],
		);

		const body = await health();
		expect(body.degraded.map((c) => c.name)).toContain('health-broken');
		expect(body.count).toBe(body.degraded.length);
	});

	it('ignores a connector that never finished its first connect, and a revoked one', async () => {
		const pid = await projectIdOf(projectSlug);
		const { row: neverConnected } = await createOrFetchConnector(db, {
			name: 'health-never',
			displayName: 'Never',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
			projectId: pid,
		});
		// auth_error but no activated_at — a first-connect failure, not a regression.
		await db.query(`UPDATE mcp_connections SET auth_error = 'discovery failed' WHERE id = $1`, [
			neverConnected.id,
		]);

		const { row: revoked } = await createOrFetchConnector(db, {
			name: 'health-revoked',
			displayName: 'Revoked',
			mcpUrl: `${fake.url}/mcp`,
			mcpTransport: 'http',
			projectId: pid,
		});
		await db.query(
			`UPDATE mcp_connections SET activated_at = now(), auth_error = 'x', revoked_at = now()
			 WHERE id = $1`,
			[revoked.id],
		);

		const names = (await health()).degraded.map((c) => c.name);
		expect(names).not.toContain('health-never');
		expect(names).not.toContain('health-revoked');
	});
});

async function projectIdOf(slug: string): Promise<string> {
	const r = await db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [slug]);
	return r.rows[0].id;
}
