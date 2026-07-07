import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { loadMcpConnectionDescriptors } from '../src/services/mcp-connections';
import { safeClose } from './helpers';
import { createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

let db: Db;
let teamId: string;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(ctx.db, { name: 'MCP Co' });
	teamId = (await teamRes.json()).data.id;

	await db.query(
		`INSERT INTO projects (team_id, name, slug, task_prefix, docker_base_image, container_status)
		 VALUES ($1, 'MCP Project', 'mcp-project', 'MP', 'hezo/agent-base:latest', NULL)`,
		[teamId],
	);
});

afterAll(async () => {
	await safeClose(db);
});

describe('mcp_connections REST routes', () => {
	it('rejects a saas connection without config.url', async () => {
		const ctx = await createTestApp();
		const co = await createTestTeam(ctx.db, { name: 'X' });
		const team = (await co.json()).data;
		const res = await ctx.app.request(
			`/api/projects/${await projectSlugFor(ctx.db, team.id)}/mcp-connections`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: 'bad', kind: 'saas', config: {} }),
			},
		);
		expect(res.status).toBe(400);
		await safeClose(ctx.db);
	});

	it('inserts a saas connection (status=installed) and lists it', async () => {
		const ctx = await createTestApp();
		const co = await createTestTeam(ctx.db, { name: 'Y' });
		const team = (await co.json()).data;
		const projectSlug = await projectSlugFor(ctx.db, team.id);
		const insert = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'exa',
				kind: 'saas',
				config: {
					url: 'https://mcp.exa.ai/mcp',
					headers: { 'x-api-key': '__HEZO_SECRET_EXA__' },
				},
			}),
		});
		expect(insert.status).toBe(201);
		const inserted = await insert.json();
		expect(inserted.data.install_status).toBe('installed');
		expect(inserted.data.kind).toBe('saas');

		const list = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections`, {
			headers: { Authorization: `Bearer ${ctx.token}` },
		});
		expect(list.status).toBe(200);
		const rows = (await list.json()).data;
		expect(rows.length).toBe(1);
		expect(rows[0].config.url).toBe('https://mcp.exa.ai/mcp');
		await safeClose(ctx.db);
	});

	it('inserts a local connection with status=pending until the installer marks it', async () => {
		const ctx = await createTestApp();
		const co = await createTestTeam(ctx.db, { name: 'Z' });
		const team = (await co.json()).data;
		const res = await ctx.app.request(
			`/api/projects/${await projectSlugFor(ctx.db, team.id)}/mcp-connections`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'fs',
					kind: 'local',
					config: {
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
					},
				}),
			},
		);
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.install_status).toBe('pending');
		await safeClose(ctx.db);
	});
});

describe('POST /projects/:projectId/mcp-connections/:id/api-key', () => {
	async function seedConnector(ctx: Awaited<ReturnType<typeof createTestApp>>) {
		const co = await createTestTeam(ctx.db, {
			name: `ApiKey ${Math.random().toString(36).slice(2)}`,
		});
		const team = (await co.json()).data;
		const projectSlug = await projectSlugFor(ctx.db, team.id);
		const insert = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'typefully',
				kind: 'saas',
				config: { url: 'https://mcp.typefully.com/mcp' },
			}),
		});
		const connector = (await insert.json()).data as { id: string };
		return { projectSlug, connectorId: connector.id };
	}

	it('stores the pasted key as a host-scoped secret, activates the connector, and emits a placeholder descriptor', async () => {
		const ctx = await createTestApp();
		const { projectSlug, connectorId } = await seedConnector(ctx);

		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/${connectorId}/api-key`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'tf_live_secret_123' }),
			},
		);
		expect(res.status).toBe(200);
		const updated = (await res.json()).data;
		expect(updated.api_key_secret_id).toBeTruthy();
		expect(updated.activated_at).toBeTruthy();

		// A host-scoped api_token secret was created (allowed_hosts = the MCP host).
		const secret = await ctx.db.query<{
			name: string;
			category: string;
			allowed_hosts: string[];
		}>(`SELECT name, category::text AS category, allowed_hosts FROM secrets WHERE id = $1`, [
			updated.api_key_secret_id,
		]);
		expect(secret.rows[0].category).toBe('api_token');
		expect(secret.rows[0].allowed_hosts).toEqual(['mcp.typefully.com']);

		// The descriptor emits a placeholder — never the raw key (red line).
		const descriptors = await loadMcpConnectionDescriptors(ctx.db);
		const tf = descriptors.find((d) => d.name === 'typefully');
		if (tf?.kind !== 'http') throw new Error('expected http descriptor');
		expect(tf.headers?.Authorization).toBe(`Bearer __HEZO_SECRET_${secret.rows[0].name}__`);
		expect(JSON.stringify(tf)).not.toContain('tf_live_secret_123');

		await safeClose(ctx.db);
	});

	it('persists a header/scheme override and reflects it in the descriptor', async () => {
		const ctx = await createTestApp();
		const { projectSlug, connectorId } = await seedConnector(ctx);

		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/${connectorId}/api-key`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'raw-key', header: 'X-API-Key', scheme: '' }),
			},
		);
		expect(res.status).toBe(200);
		const updated = (await res.json()).data;
		expect(updated.config.apiKey).toEqual({ header: 'X-API-Key', scheme: '' });

		const secret = await ctx.db.query<{ name: string }>(`SELECT name FROM secrets WHERE id = $1`, [
			updated.api_key_secret_id,
		]);
		const descriptors = await loadMcpConnectionDescriptors(ctx.db);
		const tf = descriptors.find((d) => d.name === 'typefully');
		if (tf?.kind !== 'http') throw new Error('expected http descriptor');
		expect(tf.headers?.['X-API-Key']).toBe(`__HEZO_SECRET_${secret.rows[0].name}__`);
		expect(tf.headers?.Authorization).toBeUndefined();
		await safeClose(ctx.db);
	});

	it('rejects an empty value', async () => {
		const ctx = await createTestApp();
		const { projectSlug, connectorId } = await seedConnector(ctx);
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/${connectorId}/api-key`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: '   ' }),
			},
		);
		expect(res.status).toBe(400);
		await safeClose(ctx.db);
	});

	it('revoking an api-key connector deletes the stored secret from the vault', async () => {
		const ctx = await createTestApp();
		const { projectSlug, connectorId } = await seedConnector(ctx);
		const set = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/${connectorId}/api-key`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'tf_secret' }),
			},
		);
		const secretId = (await set.json()).data.api_key_secret_id as string;

		const revoke = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/${connectorId}/revoke`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: '{}',
			},
		);
		expect(revoke.status).toBe(200);

		const secretGone = await ctx.db.query(`SELECT 1 FROM secrets WHERE id = $1`, [secretId]);
		expect(secretGone.rows.length).toBe(0);
		const conn = await ctx.db.query<{
			revoked_at: string | null;
			api_key_secret_id: string | null;
		}>(`SELECT revoked_at, api_key_secret_id FROM mcp_connections WHERE id = $1`, [connectorId]);
		expect(conn.rows[0].revoked_at).toBeTruthy();
		expect(conn.rows[0].api_key_secret_id).toBeNull();
		await safeClose(ctx.db);
	});
});

describe('POST /teams/:teamId/connectors/ensure', () => {
	it('creates a connector from the registry on first call, returns the same row on second', async () => {
		const ctx = await createTestApp();
		const co = await createTestTeam(ctx.db, { name: 'Ensure Co' });
		const team = (await co.json()).data;

		const projectSlug = await projectSlugFor(ctx.db, team.id);
		const first = await ctx.app.request(`/api/projects/${projectSlug}/connectors/ensure`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider_id: 'github' }),
		});
		expect(first.status).toBe(200);
		const firstRow = (await first.json()).data as {
			id: string;
			name: string;
			config: { url: string; headers?: Record<string, string> };
		};
		expect(firstRow.name).toBe('github');
		expect(firstRow.config.url).toBe('https://api.githubcopilot.com/mcp/');
		// The github capability ships X-MCP-Toolsets (defaults + actions) so agents
		// get get_job_logs; the ensure route must persist it into the stored config.
		expect(firstRow.config.headers?.['X-MCP-Toolsets']).toContain('actions');
		expect(firstRow.config.headers?.['X-MCP-Toolsets']).toContain('pull_requests');

		const second = await ctx.app.request(`/api/projects/${projectSlug}/connectors/ensure`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider_id: 'github' }),
		});
		expect(second.status).toBe(200);
		const secondRow = (await second.json()).data as { id: string };
		expect(secondRow.id).toBe(firstRow.id);

		await safeClose(ctx.db);
	});

	it('rejects unknown provider_id', async () => {
		const ctx = await createTestApp();
		const co = await createTestTeam(ctx.db, { name: 'Unknown Co' });
		const team = (await co.json()).data;

		const res = await ctx.app.request(
			`/api/projects/${await projectSlugFor(ctx.db, team.id)}/connectors/ensure`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider_id: 'not-a-real-provider' }),
			},
		);
		expect(res.status).toBe(404);
		await safeClose(ctx.db);
	});
});

describe('loadMcpConnectionDescriptors', () => {
	it('returns saas connections as http descriptors', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('service-a', 'saas', $1::jsonb, 'installed')`,
			[JSON.stringify({ url: 'https://service-a.example/mcp', headers: { 'x-key': 'v' } })],
		);
		const descriptors = await loadMcpConnectionDescriptors(db);
		const a = descriptors.find((d) => d.name === 'service-a');
		expect(a).toBeDefined();
		expect(a?.kind).toBe('http');
		if (a?.kind === 'http') {
			expect(a.url).toBe('https://service-a.example/mcp');
			expect(a.headers).toEqual({ 'x-key': 'v' });
		}
	});

	it('carries the github X-MCP-Toolsets header (defaults + actions) on the descriptor', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('github', 'saas', $1::jsonb, 'installed')`,
			[
				JSON.stringify({
					url: 'https://api.githubcopilot.com/mcp/',
					headers: { 'X-MCP-Toolsets': 'context,repos,issues,pull_requests,users,copilot,actions' },
				}),
			],
		);
		const descriptors = await loadMcpConnectionDescriptors(db);
		const gh = descriptors.find((d) => d.name === 'github');
		expect(gh?.kind).toBe('http');
		if (gh?.kind === 'http') {
			// Host unchanged → allowedHosts still match; `actions` is what exposes
			// get_job_logs, and `pull_requests` must remain for PR operations.
			expect(gh.url).toBe('https://api.githubcopilot.com/mcp/');
			const toolsets = (gh.headers?.['X-MCP-Toolsets'] ?? '').split(',');
			expect(toolsets).toContain('actions');
			expect(toolsets).toContain('pull_requests');
		}
	});

	it('skips local connections that are not yet installed', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('pending-local', 'local', $1::jsonb, 'pending')`,
			[JSON.stringify({ command: 'npx', args: ['-y', 'pkg'] })],
		);
		const descriptors = await loadMcpConnectionDescriptors(db);
		expect(descriptors.find((d) => d.name === 'pending-local')).toBeUndefined();
	});

	it('returns installed local connections as stdio descriptors', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('installed-local', 'local', $1::jsonb, 'installed')`,
			[JSON.stringify({ command: '/usr/bin/foo', args: ['x'], env: { K: 'v' } })],
		);
		const descriptors = await loadMcpConnectionDescriptors(db);
		const local = descriptors.find((d) => d.name === 'installed-local');
		expect(local?.kind).toBe('stdio');
		if (local?.kind === 'stdio') {
			expect(local.command).toBe('/usr/bin/foo');
			expect(local.args).toEqual(['x']);
			expect(local.env).toEqual({ K: 'v' });
		}
	});
});
