import { McpInstallStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { signAdminJwt } from '../src/middleware/auth';
import { installLocalMcpById } from '../src/services/mcp-installer';
import { authHeader, createTestTeam, projectSlugFor } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// The local-install kickoff runs against a "running" container; the stub docker
// cannot execute real installs, so the installer is mocked to a deterministic
// success — the route's per-project loop and broadcast are what's under test.
vi.mock('../src/services/mcp-installer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/services/mcp-installer')>();
	return {
		...actual,
		installLocalMcpById: vi.fn(async (_deps: unknown, rowId: string) => ({
			id: rowId,
			name: 'mocked',
			status: McpInstallStatus.Installed,
		})),
	};
});

let ctx: ServerTestContext;
let teamId: string;
let projectSlug: string;
let projectId: string;
let boardUserToken: string;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function post(path: string, body: unknown, token?: string) {
	return ctx.app.request(path, {
		method: 'POST',
		headers: { ...authHeader(token ?? ctx.token), ...JSON_HEADERS },
		body: JSON.stringify(body),
	});
}

async function errorCode(res: Response): Promise<string> {
	return ((await res.json()) as { error: { code: string } }).error.code;
}

let oauthSeq = 0;
async function seedOauthConnection(): Promise<string> {
	oauthSeq += 1;
	const secret = await ctx.db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value) VALUES ($1, 'enc') RETURNING id`,
		[`COVFILL_MCP_TOKEN_${oauthSeq}`],
	);
	const oauth = await ctx.db.query<{ id: string }>(
		`INSERT INTO oauth_connections
		   (provider, provider_account_id, provider_account_label, access_token_secret_id)
		 VALUES ('mcp:covfill', $1, 'Covfill Tester', $2) RETURNING id`,
		[`acct-${oauthSeq}`, secret.rows[0].id],
	);
	return oauth.rows[0].id;
}

beforeAll(async () => {
	ctx = await createTestContext();
	const teamRes = await createTestTeam(ctx.db, { name: 'MCP Covfill Co' });
	teamId = (await teamRes.json()).data.id;
	projectSlug = await projectSlugFor(ctx.db, teamId);
	const projRow = await ctx.db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
		projectSlug,
	]);
	projectId = projRow.rows[0].id;

	const user = await ctx.db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('MCP Board User', false) RETURNING id",
	);
	boardUserToken = await signAdminJwt(ctx.masterKeyManager, user.rows[0].id);
});

afterAll(() => destroyTestContext(ctx));

describe('admin surface: /api/mcp-connections', () => {
	it('rejects non-admin principals with 403', async () => {
		const list = await ctx.app.request('/api/mcp-connections', {
			headers: authHeader(boardUserToken),
		});
		expect(list.status).toBe(403);
		const create = await post('/api/mcp-connections', { name: 'x' }, boardUserToken);
		expect(create.status).toBe(403);
		const del = await ctx.app.request('/api/mcp-connections/00000000-0000-0000-0000-000000000000', {
			method: 'DELETE',
			headers: authHeader(boardUserToken),
		});
		expect(del.status).toBe(403);
	});

	it('validates the create body', async () => {
		const noName = await post('/api/mcp-connections', {
			kind: 'saas',
			config: { url: 'https://svc/mcp' },
		});
		expect(noName.status).toBe(400);
		expect(await errorCode(noName)).toBe('INVALID_REQUEST');

		const localKind = await post('/api/mcp-connections', {
			name: 'nope',
			kind: 'local',
			config: { command: 'npx' },
		});
		expect(localKind.status).toBe(400);
		const body = (await localKind.json()) as { error: { message: string } };
		expect(body.error.message).toContain('saas');

		const noUrl = await post('/api/mcp-connections', {
			name: 'nope',
			kind: 'saas',
			config: {},
		});
		expect(noUrl.status).toBe(400);
		expect(await errorCode(noUrl)).toBe('INVALID_REQUEST');
	});

	it('creates a connector, reconfigures it on name conflict, and lists it', async () => {
		const created = await post('/api/mcp-connections', {
			name: 'covfill-admin-conn',
			display_name: 'Covfill Conn',
			kind: 'saas',
			config: { url: 'https://one.example/mcp' },
		});
		expect(created.status).toBe(201);
		const row = (await created.json()).data as {
			id: string;
			name: string;
			display_name: string;
			install_status: string;
			config: { url: string };
		};
		expect(row.name).toBe('covfill-admin-conn');
		expect(row.display_name).toBe('Covfill Conn');
		expect(row.install_status).toBe('installed');

		// Re-adding the same name replaces config wholesale and clears auth_error.
		await ctx.db.query(`UPDATE mcp_connections SET auth_error = 'stale' WHERE id = $1`, [row.id]);
		const readd = await post('/api/mcp-connections', {
			name: 'covfill-admin-conn',
			kind: 'saas',
			config: { url: 'https://two.example/mcp' },
		});
		expect(readd.status).toBe(201);
		const updated = (await readd.json()).data as {
			id: string;
			config: { url: string };
			auth_error: string | null;
		};
		expect(updated.id).toBe(row.id);
		expect(updated.config.url).toBe('https://two.example/mcp');
		expect(updated.auth_error).toBeNull();

		const list = await ctx.app.request('/api/mcp-connections', { headers: authHeader(ctx.token) });
		expect(list.status).toBe(200);
		const rows = (await list.json()).data as Array<{ name: string }>;
		expect(rows.some((r) => r.name === 'covfill-admin-conn')).toBe(true);
	});

	it('deletes a connector and 404s on the second attempt', async () => {
		const created = await post('/api/mcp-connections', {
			name: 'covfill-delete-me',
			kind: 'saas',
			config: { url: 'https://del.example/mcp' },
		});
		const id = ((await created.json()).data as { id: string }).id;

		const del = await ctx.app.request(`/api/mcp-connections/${id}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(del.status).toBe(200);
		expect(((await del.json()) as { data: null }).data).toBeNull();

		const again = await ctx.app.request(`/api/mcp-connections/${id}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(again.status).toBe(404);
		expect(await errorCode(again)).toBe('NOT_FOUND');
	});
});

describe('project surface: /api/projects/:projectId/mcp-connections', () => {
	it('lists the global catalog and fetches a single row', async () => {
		const created = await post(`/api/projects/${projectSlug}/mcp-connections`, {
			name: 'covfill-proj-conn',
			kind: 'saas',
			config: { url: 'https://proj.example/mcp' },
		});
		expect(created.status).toBe(201);
		const id = ((await created.json()).data as { id: string }).id;

		const list = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections`, {
			headers: authHeader(ctx.token),
		});
		expect(list.status).toBe(200);
		expect(((await list.json()).data as Array<{ id: string }>).some((r) => r.id === id)).toBe(true);

		const one = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections/${id}`, {
			headers: authHeader(ctx.token),
		});
		expect(one.status).toBe(200);
		expect(((await one.json()).data as { name: string }).name).toBe('covfill-proj-conn');

		const missing = await ctx.app.request(
			`/api/projects/${projectSlug}/mcp-connections/00000000-0000-0000-0000-000000000000`,
			{ headers: authHeader(ctx.token) },
		);
		expect(missing.status).toBe(404);
	});

	it('validates the project-scoped create body', async () => {
		const cases: Array<{ body: Record<string, unknown>; fragment: string }> = [
			{ body: { kind: 'saas', config: { url: 'https://x/mcp' } }, fragment: 'name is required' },
			{ body: { name: 'x', kind: 'weird', config: {} }, fragment: 'kind must be' },
			{ body: { name: 'x', kind: 'saas', config: {} }, fragment: 'config.url' },
			{ body: { name: 'x', kind: 'local', config: {} }, fragment: 'config.command' },
		];
		for (const { body, fragment } of cases) {
			const res = await post(`/api/projects/${projectSlug}/mcp-connections`, body);
			expect(res.status).toBe(400);
			const err = (await res.json()) as { error: { code: string; message: string } };
			expect(err.error.code).toBe('INVALID_REQUEST');
			expect(err.error.message).toContain(fragment);
		}
	});

	it('404s on an unknown oauth_connection_id', async () => {
		const res = await post(`/api/projects/${projectSlug}/mcp-connections`, {
			name: 'covfill-bad-oauth',
			kind: 'saas',
			config: { url: 'https://x/mcp' },
			oauth_connection_id: '00000000-0000-0000-0000-000000000000',
		});
		expect(res.status).toBe(404);
		expect(await errorCode(res)).toBe('NOT_FOUND');
	});

	it('accepts a valid oauth_connection_id', async () => {
		const oauthId = await seedOauthConnection();
		const res = await post(`/api/projects/${projectSlug}/mcp-connections`, {
			name: 'covfill-with-oauth',
			kind: 'saas',
			config: { url: 'https://oauth.example/mcp' },
			oauth_connection_id: oauthId,
		});
		expect(res.status).toBe(201);
		expect(((await res.json()).data as { oauth_connection_id: string }).oauth_connection_id).toBe(
			oauthId,
		);
	});

	it('creates a local connector pending and kicks off install on running containers', async () => {
		await ctx.db.query(
			`UPDATE projects SET container_id = 'covfill-mcp-container', container_status = 'running' WHERE id = $1`,
			[projectId],
		);
		const res = await post(`/api/projects/${projectSlug}/mcp-connections`, {
			name: 'covfill-local-conn',
			kind: 'local',
			config: { command: 'npx', args: ['-y', 'some-mcp'] },
		});
		expect(res.status).toBe(201);
		const row = (await res.json()).data as { id: string; install_status: string };
		expect(row.install_status).toBe('pending');

		await waitForBackground();
		// The kickoff loop reached the running container's project.
		expect(vi.mocked(installLocalMcpById)).toHaveBeenCalledWith(
			expect.objectContaining({ containerId: 'covfill-mcp-container', teamId }),
			row.id,
		);
		await ctx.db.query(
			`UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1`,
			[projectId],
		);
	});

	it('deletes a connection project-scoped and 404s when unknown', async () => {
		const created = await post(`/api/projects/${projectSlug}/mcp-connections`, {
			name: 'covfill-proj-delete',
			kind: 'saas',
			config: { url: 'https://projdel.example/mcp' },
		});
		const id = ((await created.json()).data as { id: string }).id;

		const del = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections/${id}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(del.status).toBe(200);
		const gone = await ctx.db.query('SELECT id FROM mcp_connections WHERE id = $1', [id]);
		expect(gone.rows).toHaveLength(0);

		const again = await ctx.app.request(`/api/projects/${projectSlug}/mcp-connections/${id}`, {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(again.status).toBe(404);
		expect(await errorCode(again)).toBe('NOT_FOUND');
	});
});

describe('POST /projects/:projectId/mcp-connections/:id/revoke', () => {
	it('404s on an unknown connector', async () => {
		const res = await post(
			`/api/projects/${projectSlug}/mcp-connections/00000000-0000-0000-0000-000000000000/revoke`,
			{},
		);
		expect(res.status).toBe(404);
	});

	it('marks the row revoked and deletes an attached oauth connection', async () => {
		const oauthId = await seedOauthConnection();
		const created = await post(`/api/projects/${projectSlug}/mcp-connections`, {
			name: 'covfill-revoke-me',
			kind: 'saas',
			config: { url: 'https://revoke.example/mcp' },
			oauth_connection_id: oauthId,
		});
		const id = ((await created.json()).data as { id: string }).id;

		const res = await post(`/api/projects/${projectSlug}/mcp-connections/${id}/revoke`, {});
		expect(res.status).toBe(200);
		const row = (await res.json()).data as { revoked_at: string | null };
		expect(row.revoked_at).not.toBeNull();

		await waitForBackground();
		const oauthRows = await ctx.db.query('SELECT id FROM oauth_connections WHERE id = $1', [
			oauthId,
		]);
		expect(oauthRows.rows).toHaveLength(0);
	});

	it('revokes a connector without an oauth connection', async () => {
		const created = await post(`/api/projects/${projectSlug}/mcp-connections`, {
			name: 'covfill-revoke-plain',
			kind: 'saas',
			config: { url: 'https://revoke2.example/mcp' },
		});
		const id = ((await created.json()).data as { id: string }).id;
		const res = await post(`/api/projects/${projectSlug}/mcp-connections/${id}/revoke`, {});
		expect(res.status).toBe(200);
		const dbRow = await ctx.db.query<{ revoked_at: string | null }>(
			'SELECT revoked_at FROM mcp_connections WHERE id = $1',
			[id],
		);
		expect(dbRow.rows[0].revoked_at).not.toBeNull();
	});
});

describe('POST /projects/:projectId/connectors/ensure', () => {
	it('requires provider_id (including on an unparseable body)', async () => {
		const res = await post(`/api/projects/${projectSlug}/connectors/ensure`, {});
		expect(res.status).toBe(400);
		expect(await errorCode(res)).toBe('INVALID_REQUEST');

		const notJson = await ctx.app.request(`/api/projects/${projectSlug}/connectors/ensure`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), ...JSON_HEADERS },
			body: '<<<',
		});
		expect(notJson.status).toBe(400);
		expect(await errorCode(notJson)).toBe('INVALID_REQUEST');
	});

	it('404s on a provider_id with no registered capability', async () => {
		const res = await post(`/api/projects/${projectSlug}/connectors/ensure`, {
			provider_id: 'definitely-not-registered',
		});
		expect(res.status).toBe(404);
		expect(await errorCode(res)).toBe('NOT_FOUND');
	});

	it('materializes a registry connector idempotently', async () => {
		const first = await post(`/api/projects/${projectSlug}/connectors/ensure`, {
			provider_id: 'linear',
		});
		expect(first.status).toBe(200);
		const row = (await first.json()).data as { id: string; name: string };
		expect(row.name).toBe('linear');

		const second = await post(`/api/projects/${projectSlug}/connectors/ensure`, {
			provider_id: 'linear',
		});
		expect(second.status).toBe(200);
		expect(((await second.json()).data as { id: string }).id).toBe(row.id);

		const rows = await ctx.db.query("SELECT id FROM mcp_connections WHERE name = 'linear'");
		expect(rows.rows).toHaveLength(1);
	});
});
