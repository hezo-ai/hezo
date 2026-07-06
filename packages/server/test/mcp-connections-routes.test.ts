import { McpConnectionKind } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugFor } from './helpers/app';

/**
 * Route coverage for the MCP-connections surface that the existing
 * mcp-connections.test.ts doesn't reach: the instance-global Admin routes
 * (un-prefixed GET/POST/DELETE /mcp-connections), the project-scoped GET-by-id,
 * DELETE, and revoke, plus their not-found / authorization branches.
 *
 * Boots the in-process Hono app directly (createTestApp), so no live HTTP
 * server / port is involved — requests go through ctx.app.request.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

let ctx: Ctx;
let token: string;
let nonAdminToken: string;
let masterKeyManager: MasterKeyManager;
let projectSlug: string;

beforeAll(async () => {
	ctx = await createTestApp();
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(ctx.db, { name: 'MCP Routes Co' });
	const teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(ctx.db, teamId);

	const nonAdmin = await ctx.db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Plain User', false) RETURNING id",
	);
	nonAdminToken = await signAdminJwt(masterKeyManager, nonAdmin.rows[0].id);
});

afterAll(async () => {
	await safeClose(ctx.db);
});

describe('admin (instance-global) /mcp-connections routes', () => {
	let createdId: string;

	it('rejects a non-superuser from listing the global catalog', async () => {
		const res = await ctx.app.request('/api/mcp-connections', {
			headers: authHeader(nonAdminToken),
		});
		expect(res.status).toBe(403);
	});

	it('creates a saas connector via the admin route and lists it', async () => {
		const create = await ctx.app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'admin-exa',
				display_name: 'Admin Exa',
				kind: 'saas',
				config: { url: 'https://mcp.exa.ai/mcp' },
			}),
		});
		expect(create.status).toBe(201);
		const created = (await create.json()).data as { id: string; install_status: string };
		expect(created.install_status).toBe('installed');
		createdId = created.id;

		const list = await ctx.app.request('/api/mcp-connections', { headers: authHeader(token) });
		expect(list.status).toBe(200);
		const rows = (await list.json()).data as Array<{ id: string; display_name: string }>;
		expect(rows.find((r) => r.id === createdId)?.display_name).toBe('Admin Exa');
	});

	it('upserts on name conflict, updating config in place', async () => {
		const res = await ctx.app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'admin-exa',
				display_name: 'Admin Exa v2',
				kind: 'saas',
				config: { url: 'https://mcp.exa.ai/v2' },
			}),
		});
		expect(res.status).toBe(201);
		const row = (await res.json()).data as {
			id: string;
			display_name: string;
			config: { url: string };
		};
		expect(row.id).toBe(createdId);
		expect(row.display_name).toBe('Admin Exa v2');
		expect(row.config.url).toBe('https://mcp.exa.ai/v2');
	});

	it('rejects an admin create with no name', async () => {
		const res = await ctx.app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: '  ', kind: 'saas', config: { url: 'https://x/mcp' } }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('name is required');
	});

	it('rejects a non-saas kind on the admin route', async () => {
		const res = await ctx.app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'admin-local',
				kind: 'local',
				config: { command: 'npx' },
			}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('saas');
	});

	it('rejects a saas connector missing config.url', async () => {
		const res = await ctx.app.request('/api/mcp-connections', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'admin-nourl', kind: 'saas', config: {} }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('config.url');
	});

	it('rejects a non-superuser DELETE on the admin route', async () => {
		const res = await ctx.app.request(`/api/mcp-connections/${createdId}`, {
			method: 'DELETE',
			headers: authHeader(nonAdminToken),
		});
		expect(res.status).toBe(403);
	});

	it('returns 404 deleting an unknown connector', async () => {
		const res = await ctx.app.request('/api/mcp-connections/00000000-0000-0000-0000-000000000000', {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.code).toBe('NOT_FOUND');
	});

	it('deletes a connector and returns data:null', async () => {
		const res = await ctx.app.request(`/api/mcp-connections/${createdId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toBeNull();

		const gone = await ctx.db.query('SELECT 1 FROM mcp_connections WHERE id = $1', [createdId]);
		expect(gone.rows.length).toBe(0);
	});
});

describe('project-scoped /projects/:projectId/mcp-connections/:id', () => {
	async function seedSaasConnector(name: string): Promise<string> {
		const project = await ctx.db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [
			projectSlug,
		]);
		const r = await ctx.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
			 VALUES ($1, $2::mcp_connection_kind, '{"url": "https://svc/mcp"}'::jsonb, 'installed', $3)
			 RETURNING id`,
			[name, McpConnectionKind.Saas, project.rows[0].id],
		);
		return r.rows[0].id;
	}

	it('reads a single connector by id', async () => {
		const id = await seedSaasConnector('proj-read');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections/${id}`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const row = (await res.json()).data as { id: string; name: string };
		expect(row.id).toBe(id);
		expect(row.name).toBe('proj-read');
	});

	it('returns 404 reading an unknown connector', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/00000000-0000-0000-0000-000000000000`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it('returns 404 deleting an unknown connector', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toContain('MCP connection not found');
	});

	it('deletes a connector via the project-scoped route', async () => {
		const id = await seedSaasConnector('proj-del');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toBeNull();
		const gone = await ctx.db.query('SELECT 1 FROM mcp_connections WHERE id = $1', [id]);
		expect(gone.rows.length).toBe(0);
	});

	it('revokes a connector (no oauth connection attached)', async () => {
		const id = await seedSaasConnector('proj-revoke');
		const res = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections/${id}/revoke`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const row = (await res.json()).data as { id: string; revoked_at: string | null };
		expect(row.id).toBe(id);
		expect(row.revoked_at).toBeTruthy();
	});

	it('returns 404 revoking an unknown connector', async () => {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/00000000-0000-0000-0000-000000000000/revoke`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('project-scoped POST /mcp-connections branches', () => {
	it('rejects an unknown oauth_connection_id with 404', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'with-bad-oauth',
				kind: 'saas',
				config: { url: 'https://svc/mcp' },
				oauth_connection_id: '00000000-0000-0000-0000-000000000000',
			}),
		});
		expect(res.status).toBe(404);
		expect((await res.json()).error.message).toContain('oauth_connection_id not found');
	});

	it('rejects an unknown kind with 400', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'weird', kind: 'grpc', config: {} }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('kind must be');
	});

	it('rejects a local connection missing config.command with 400', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'local-nocmd', kind: 'local', config: { args: [] } }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('config.command');
	});

	it('rejects a project-scoped create with no name', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind: 'saas', config: { url: 'https://svc/mcp' } }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('name is required');
	});

	it('rejects connectors/ensure with no provider_id', async () => {
		const res = await ctx.app.request(`/api/projects/${projectSlug}/connectors/ensure`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toContain('provider_id is required');
	});
});

describe('cross-project connector isolation', () => {
	it("a project's list shows its own + global connectors, never another project's", async () => {
		// Two separate projects, plus a global ("all projects") connector.
		const teamA = (await (await createTestTeam(ctx.db, { name: 'Iso A' })).json()).data.id;
		const teamB = (await (await createTestTeam(ctx.db, { name: 'Iso B' })).json()).data.id;
		const slugA = await projectSlugFor(ctx.db, teamA);
		const slugB = await projectSlugFor(ctx.db, teamB);
		const projA = await ctx.db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
			slugA,
		]);
		const projB = await ctx.db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
			slugB,
		]);

		await ctx.db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
			 VALUES ('iso-a-only', 'saas', '{"url":"https://a/mcp"}'::jsonb, 'installed', $1)`,
			[projA.rows[0].id],
		);
		await ctx.db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
			 VALUES ('iso-b-only', 'saas', '{"url":"https://b/mcp"}'::jsonb, 'installed', $1)`,
			[projB.rows[0].id],
		);
		await ctx.db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
			 VALUES ('iso-global', 'saas', '{"url":"https://g/mcp"}'::jsonb, 'installed', NULL)`,
		);

		const listOf = async (slug: string) => {
			const res = await ctx.app.request(`/api/projects/${slug}/mcp-connections`, {
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			return ((await res.json()).data as Array<{ name: string }>).map((r) => r.name);
		};

		const aNames = await listOf(slugA);
		expect(aNames).toContain('iso-a-only');
		expect(aNames).toContain('iso-global');
		expect(aNames).not.toContain('iso-b-only');

		const bNames = await listOf(slugB);
		expect(bNames).toContain('iso-b-only');
		expect(bNames).toContain('iso-global');
		expect(bNames).not.toContain('iso-a-only');

		// The admin cross-project list spans everything and annotates each row's
		// owning project (null for the global one).
		const adminRes = await ctx.app.request('/api/mcp-connections', { headers: authHeader(token) });
		const adminRows = (await adminRes.json()).data as Array<{
			name: string;
			project_id: string | null;
			project_name: string | null;
		}>;
		const byName = new Map(adminRows.map((r) => [r.name, r]));
		expect(byName.get('iso-a-only')?.project_id).toBe(projA.rows[0].id);
		expect(byName.get('iso-b-only')?.project_id).toBe(projB.rows[0].id);
		expect(byName.get('iso-global')?.project_id).toBeNull();
		expect(byName.get('iso-a-only')?.project_name).toBeTruthy();
	});

	it("a project cannot delete another project's connector", async () => {
		const teamA = (await (await createTestTeam(ctx.db, { name: 'Iso Del A' })).json()).data.id;
		const teamB = (await (await createTestTeam(ctx.db, { name: 'Iso Del B' })).json()).data.id;
		const slugA = await projectSlugFor(ctx.db, teamA);
		const slugB = await projectSlugFor(ctx.db, teamB);
		const projA = await ctx.db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
			slugA,
		]);
		const inserted = await ctx.db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
			 VALUES ('iso-del', 'saas', '{"url":"https://a/mcp"}'::jsonb, 'installed', $1) RETURNING id`,
			[projA.rows[0].id],
		);
		// Project B tries to delete project A's connector → 404, row still present.
		const res = await ctx.app.request(
			`/api/projects/${slugB}/mcp-connections/${inserted.rows[0].id}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
		const still = await ctx.db.query('SELECT 1 FROM mcp_connections WHERE id = $1', [
			inserted.rows[0].id,
		]);
		expect(still.rows.length).toBe(1);
	});
});
