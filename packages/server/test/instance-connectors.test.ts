import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { loadMcpConnectionsForRun } from '../src/services/mcp-connections';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

async function makeProject(teamId: string, slug: string): Promise<string> {
	const row = await db.query<{ id: string }>(
		`INSERT INTO projects (team_id, name, slug, task_prefix, docker_base_image, container_status)
		 VALUES ($1, $2, $2, 'P', 'hezo/agent-base:latest', NULL)
		 RETURNING id`,
		[teamId, slug],
	);
	return row.rows[0].id;
}

async function makeTeam(name: string): Promise<string> {
	const res = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	return (await res.json()).data.id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
});

afterAll(async () => {
	await safeClose(db);
});

describe('instance-level connectors', () => {
	it('an instance saas connector (team_id NULL) is shared with every team', async () => {
		const createRes = await app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'shared-docs',
				display_name: 'Shared Docs',
				kind: 'saas',
				config: { url: 'https://mcp.example.com/docs' },
			}),
		});
		expect(createRes.status).toBe(201);
		const conn = (await createRes.json()).data;
		expect(conn.team_id).toBeNull();
		expect(conn.install_status).toBe('installed');
		expect(conn.kind).toBe('saas');

		// Listed under the instance connectors.
		const instRes = await app.request('/api/mcp-connections', { headers: authHeader(token) });
		expect(
			(await instRes.json()).data.some((r: { name: string }) => r.name === 'shared-docs'),
		).toBe(true);

		// A team's own connectors list includes the instance connector.
		const teamId = await makeTeam('Connectors Team');
		const projectId = await makeProject(teamId, 'connectors-project');

		const teamListRes = await app.request(`/api/teams/${teamId}/mcp-connections`, {
			headers: authHeader(token),
		});
		const teamRows = (await teamListRes.json()).data as { name: string; team_id: string | null }[];
		expect(teamRows.some((r) => r.name === 'shared-docs' && r.team_id === null)).toBe(true);

		// And the run-loader returns it for that team/project.
		const forRun = await loadMcpConnectionsForRun(db, teamId, projectId);
		expect(forRun.some((r) => r.name === 'shared-docs')).toBe(true);
	});

	it('a team-specific connector wins the name dedup over an instance one', async () => {
		await app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'dup',
				kind: 'saas',
				config: { url: 'https://instance.example.com/mcp' },
			}),
		});

		const teamId = await makeTeam('Dedup Team');
		const projectId = await makeProject(teamId, 'dedup-project');

		// Team-specific connector with the same name, different url.
		await app.request(`/api/teams/${teamId}/mcp-connections`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'dup',
				kind: 'saas',
				config: { url: 'https://team.example.com/mcp' },
			}),
		});

		const forRun = await loadMcpConnectionsForRun(db, teamId, projectId);
		const dup = forRun.filter((r) => r.name === 'dup');
		expect(dup.length).toBe(1);
		expect((dup[0].config as { url: string }).url).toBe('https://team.example.com/mcp');
	});

	it('rejects a local connector at the instance level', async () => {
		const res = await app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'local-thing',
				kind: 'local',
				config: { command: 'npx' },
			}),
		});
		expect(res.status).toBe(400);
	});

	it('rejects a saas connector without config.url', async () => {
		const res = await app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'no-url', kind: 'saas', config: {} }),
		});
		expect(res.status).toBe(400);
	});

	it('deletes an instance connector', async () => {
		const createRes = await app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'to-delete',
				kind: 'saas',
				config: { url: 'https://delete.example.com/mcp' },
			}),
		});
		const id = (await createRes.json()).data.id;

		const del = await app.request(`/api/mcp-connections/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		const instRes = await app.request('/api/mcp-connections', { headers: authHeader(token) });
		expect((await instRes.json()).data.some((r: { id: string }) => r.id === id)).toBe(false);

		// Deleting again is a 404.
		const again = await app.request(`/api/mcp-connections/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(again.status).toBe(404);
	});

	it('requires superuser for instance connector management', async () => {
		const nonSuper = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		const memberToken = await signAdminJwt(masterKeyManager, nonSuper.rows[0].id);

		const listRes = await app.request('/api/mcp-connections', {
			headers: authHeader(memberToken),
		});
		expect(listRes.status).toBe(403);

		const postRes = await app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(memberToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'nope',
				kind: 'saas',
				config: { url: 'https://x.example.com/mcp' },
			}),
		});
		expect(postRes.status).toBe(403);
	});
});
