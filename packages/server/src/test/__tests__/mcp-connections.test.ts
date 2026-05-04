import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	loadMcpConnectionDescriptors,
	loadMcpConnectionsForRun,
} from '../../services/mcp-connections';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
let companyId: string;
let projectId: string;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	token = ctx.token;

	const companyRes = await ctx.app.request('/api/companies', {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'MCP Co' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRow = await db.query<{ id: string }>(
		`INSERT INTO projects (company_id, name, slug, issue_prefix, docker_base_image, container_status)
		 VALUES ($1, 'MCP Project', 'mcp-project', 'MP', 'hezo/agent-base:latest', NULL)
		 RETURNING id`,
		[companyId],
	);
	projectId = projectRow.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('mcp_connections REST routes', () => {
	it('rejects a saas connection without config.url', async () => {
		const ctx = await createTestApp();
		const co = await ctx.app.request('/api/companies', {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'X' }),
		});
		const cid = (await co.json()).data.id;
		const res = await ctx.app.request(`/api/companies/${cid}/mcp-connections`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'bad', kind: 'saas', config: {} }),
		});
		expect(res.status).toBe(400);
		await safeClose(ctx.db);
	});

	it('inserts a saas connection (status=installed) and lists it', async () => {
		const ctx = await createTestApp();
		const co = await ctx.app.request('/api/companies', {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Y' }),
		});
		const cid = (await co.json()).data.id;
		const insert = await ctx.app.request(`/api/companies/${cid}/mcp-connections`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'exa',
				kind: 'saas',
				config: { url: 'https://mcp.exa.ai/mcp', headers: { 'x-api-key': '__HEZO_SECRET_EXA__' } },
			}),
		});
		expect(insert.status).toBe(201);
		const inserted = await insert.json();
		expect(inserted.data.install_status).toBe('installed');
		expect(inserted.data.kind).toBe('saas');

		const list = await ctx.app.request(`/api/companies/${cid}/mcp-connections`, {
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
		const co = await ctx.app.request('/api/companies', {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Z' }),
		});
		const cid = (await co.json()).data.id;
		const res = await ctx.app.request(`/api/companies/${cid}/mcp-connections`, {
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
		});
		expect(res.status).toBe(201);
		const data = (await res.json()).data;
		expect(data.install_status).toBe('pending');
		await safeClose(ctx.db);
	});
});

describe('loadMcpConnectionDescriptors', () => {
	it('returns saas connections as http descriptors', async () => {
		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, NULL, 'service-a', 'saas', $2::jsonb, 'installed')`,
			[
				companyId,
				JSON.stringify({ url: 'https://service-a.example/mcp', headers: { 'x-key': 'v' } }),
			],
		);
		const descriptors = await loadMcpConnectionDescriptors(db, companyId, projectId);
		const a = descriptors.find((d) => d.name === 'service-a');
		expect(a).toBeDefined();
		expect(a?.kind).toBe('http');
		if (a?.kind === 'http') {
			expect(a.url).toBe('https://service-a.example/mcp');
			expect(a.headers).toEqual({ 'x-key': 'v' });
		}
	});

	it('skips local connections that are not yet installed', async () => {
		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, NULL, 'pending-local', 'local', $2::jsonb, 'pending')`,
			[companyId, JSON.stringify({ command: 'npx', args: ['-y', 'pkg'] })],
		);
		const descriptors = await loadMcpConnectionDescriptors(db, companyId, projectId);
		expect(descriptors.find((d) => d.name === 'pending-local')).toBeUndefined();
	});

	it('returns installed local connections as stdio descriptors', async () => {
		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, NULL, 'installed-local', 'local', $2::jsonb, 'installed')`,
			[companyId, JSON.stringify({ command: '/usr/bin/foo', args: ['x'], env: { K: 'v' } })],
		);
		const descriptors = await loadMcpConnectionDescriptors(db, companyId, projectId);
		const local = descriptors.find((d) => d.name === 'installed-local');
		expect(local?.kind).toBe('stdio');
		if (local?.kind === 'stdio') {
			expect(local.command).toBe('/usr/bin/foo');
			expect(local.args).toEqual(['x']);
			expect(local.env).toEqual({ K: 'v' });
		}
	});

	it('project-scoped connections override company-wide entries with the same name', async () => {
		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, NULL, 'shared', 'saas', $2::jsonb, 'installed')`,
			[companyId, JSON.stringify({ url: 'https://company-wide.example/mcp' })],
		);
		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, $2, 'shared', 'saas', $3::jsonb, 'installed')`,
			[companyId, projectId, JSON.stringify({ url: 'https://project-only.example/mcp' })],
		);
		const rows = await loadMcpConnectionsForRun(db, companyId, projectId);
		const shared = rows.find((r) => r.name === 'shared');
		expect((shared?.config as { url: string }).url).toBe('https://project-only.example/mcp');
	});
});
