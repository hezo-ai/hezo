import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { loadConnectorDescriptors } from '../src/services/connectors/connections';
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
			`/api/projects/${await projectSlugFor(ctx.db, team.id)}/connectors`,
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
		const insert = await ctx.app.request(`/api/projects/${projectSlug}/connectors`, {
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

		const list = await ctx.app.request(`/api/projects/${projectSlug}/connectors`, {
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
			`/api/projects/${await projectSlugFor(ctx.db, team.id)}/connectors`,
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

describe('POST /projects/:projectId/connectors/:id/api-key', () => {
	async function seedConnector(ctx: Awaited<ReturnType<typeof createTestApp>>) {
		const co = await createTestTeam(ctx.db, {
			name: `ApiKey ${Math.random().toString(36).slice(2)}`,
		});
		const team = (await co.json()).data;
		const projectSlug = await projectSlugFor(ctx.db, team.id);
		const insert = await ctx.app.request(`/api/projects/${projectSlug}/connectors`, {
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
			`/api/projects/${projectSlug}/connectors/${connectorId}/api-key`,
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
		const descriptors = await loadConnectorDescriptors(ctx.db);
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
			`/api/projects/${projectSlug}/connectors/${connectorId}/api-key`,
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
		const descriptors = await loadConnectorDescriptors(ctx.db);
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
			`/api/projects/${projectSlug}/connectors/${connectorId}/api-key`,
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
			`/api/projects/${projectSlug}/connectors/${connectorId}/api-key`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'tf_secret' }),
			},
		);
		const secretId = (await set.json()).data.api_key_secret_id as string;

		const revoke = await ctx.app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/revoke`,
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

	it('restores a revoked connector when a new api key is pasted (fresh reconnect)', async () => {
		const ctx = await createTestApp();
		const { projectSlug, connectorId } = await seedConnector(ctx);

		// Connect, then revoke — leaves the row revoked with no key.
		const setUrl = `/api/projects/${projectSlug}/connectors/${connectorId}/api-key`;
		await ctx.app.request(setUrl, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'tf_old' }),
		});
		await ctx.app.request(`/api/projects/${projectSlug}/connectors/${connectorId}/revoke`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: '{}',
		});

		// Pasting a new key restores in place rather than erroring with CONNECTOR_REVOKED.
		const res = await ctx.app.request(setUrl, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'tf_new' }),
		});
		expect(res.status).toBe(200);
		const updated = (await res.json()).data as {
			revoked_at: string | null;
			activated_at: string | null;
			api_key_secret_id: string | null;
		};
		expect(updated.revoked_at).toBeNull();
		expect(updated.activated_at).toBeTruthy();
		expect(updated.api_key_secret_id).toBeTruthy();

		// The descriptor now emits the new key's placeholder (never the raw value).
		const descriptors = await loadConnectorDescriptors(ctx.db);
		const tf = descriptors.find((d) => d.name === 'typefully');
		if (tf?.kind !== 'http') throw new Error('expected http descriptor');
		expect(tf.headers?.Authorization).toContain('__HEZO_SECRET_');
		expect(JSON.stringify(tf)).not.toContain('tf_new');
		await safeClose(ctx.db);
	});
});

describe('api-key credential naming + connector→credential relationship', () => {
	function projFrag(projectId: string): string {
		return projectId.replace(/-/g, '').slice(0, 5).toUpperCase();
	}

	async function seedProjectConnector(
		ctx: Awaited<ReturnType<typeof createTestApp>>,
		name: string,
	): Promise<{ projectSlug: string; projectId: string; connectorId: string }> {
		const co = await createTestTeam(ctx.db, {
			name: `Name ${Math.random().toString(36).slice(2)}`,
		});
		const team = (await co.json()).data;
		const projectSlug = await projectSlugFor(ctx.db, team.id);
		const proj = await ctx.db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [
			projectSlug,
		]);
		const insert = await ctx.app.request(`/api/projects/${projectSlug}/connectors`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name, kind: 'saas', config: { url: 'https://mcp.name.example/mcp' } }),
		});
		const connector = (await insert.json()).data as { id: string };
		return { projectSlug, projectId: proj.rows[0].id, connectorId: connector.id };
	}

	async function setApiKey(
		ctx: Awaited<ReturnType<typeof createTestApp>>,
		projectSlug: string,
		connectorId: string,
	): Promise<string> {
		const res = await ctx.app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/api-key`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: `key_${Math.random().toString(36).slice(2)}` }),
			},
		);
		return (await res.json()).data.api_key_secret_id as string;
	}

	it('qualifies a project-scoped connector credential with the project UUID fragment', async () => {
		const ctx = await createTestApp();
		const { projectSlug, projectId, connectorId } = await seedProjectConnector(ctx, 'namedmcp');
		const secretId = await setApiKey(ctx, projectSlug, connectorId);
		const secret = await ctx.db.query<{ name: string }>(`SELECT name FROM secrets WHERE id = $1`, [
			secretId,
		]);
		const name = secret.rows[0].name;
		const { validateSecretName } = await import('../src/lib/credential-placeholder');
		expect(validateSecretName(name).valid).toBe(true);
		expect(name).toBe(`MCP_NAMEDMCP_${projFrag(projectId)}`);
		await safeClose(ctx.db);
	});

	it('gives two same-type connectors in different projects distinctly-named credentials', async () => {
		const ctx = await createTestApp();
		const a = await seedProjectConnector(ctx, 'shared');
		const b = await seedProjectConnector(ctx, 'shared');
		const nameA = (
			await ctx.db.query<{ name: string }>(`SELECT name FROM secrets WHERE id = $1`, [
				await setApiKey(ctx, a.projectSlug, a.connectorId),
			])
		).rows[0].name;
		const nameB = (
			await ctx.db.query<{ name: string }>(`SELECT name FROM secrets WHERE id = $1`, [
				await setApiKey(ctx, b.projectSlug, b.connectorId),
			])
		).rows[0].name;
		expect(nameA).not.toBe(nameB);
		expect(nameA.endsWith(projFrag(a.projectId))).toBe(true);
		expect(nameB.endsWith(projFrag(b.projectId))).toBe(true);
		await safeClose(ctx.db);
	});

	it('leaves a global connector credential unqualified (no project fragment)', async () => {
		const ctx = await createTestApp();
		// Admin surface creates a global (project_id null) connector; the api-key
		// route accepts it (project_id IS NULL) via any project path.
		const created = await ctx.app.request(`/api/connectors`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'globalmcp',
				kind: 'saas',
				config: { url: 'https://mcp.global.example/mcp' },
				project_id: null,
			}),
		});
		const connectorId = (await created.json()).data.id as string;
		const co = await createTestTeam(ctx.db, { name: 'Any Proj' });
		const projectSlug = await projectSlugFor(ctx.db, (await co.json()).data.id);
		const secretId = await setApiKey(ctx, projectSlug, connectorId);
		const name = (
			await ctx.db.query<{ name: string }>(`SELECT name FROM secrets WHERE id = $1`, [secretId])
		).rows[0].name;
		expect(name).toBe('MCP_GLOBALMCP');
		await safeClose(ctx.db);
	});

	it('the connector list surfaces the credential(s) it uses', async () => {
		const ctx = await createTestApp();
		const { projectSlug, connectorId } = await seedProjectConnector(ctx, 'listcreds');
		const secretId = await setApiKey(ctx, projectSlug, connectorId);
		const list = await ctx.app.request(`/api/projects/${projectSlug}/connectors`, {
			headers: { Authorization: `Bearer ${ctx.token}` },
		});
		const row = ((await list.json()).data as { id: string; credentials: { id: string }[] }[]).find(
			(r) => r.id === connectorId,
		);
		expect(row?.credentials).toHaveLength(1);
		expect(row?.credentials[0].id).toBe(secretId);
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

describe('loadConnectorDescriptors', () => {
	it('returns saas connections as http descriptors', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('service-a', 'saas', $1::jsonb, 'installed')`,
			[JSON.stringify({ url: 'https://service-a.example/mcp', headers: { 'x-key': 'v' } })],
		);
		const descriptors = await loadConnectorDescriptors(db);
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
		const descriptors = await loadConnectorDescriptors(db);
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
		const descriptors = await loadConnectorDescriptors(db);
		expect(descriptors.find((d) => d.name === 'pending-local')).toBeUndefined();
	});

	it('returns installed local connections as stdio descriptors', async () => {
		await db.query(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('installed-local', 'local', $1::jsonb, 'installed')`,
			[JSON.stringify({ command: '/usr/bin/foo', args: ['x'], env: { K: 'v' } })],
		);
		const descriptors = await loadConnectorDescriptors(db);
		const local = descriptors.find((d) => d.name === 'installed-local');
		expect(local?.kind).toBe('stdio');
		if (local?.kind === 'stdio') {
			expect(local.command).toBe('/usr/bin/foo');
			expect(local.args).toEqual(['x']);
			expect(local.env).toEqual({ K: 'v' });
		}
	});
});

describe('loadConnectorDescriptors project scoping', () => {
	// The plan's core multi-project claim: two projects can each register their own
	// project-scoped `local` MCP (same connection name, same env var) whose
	// config.env references its OWN per-project secret placeholder. A run only
	// loads its own project's connection, so the two credentials never collide.
	it('gives two projects independent local-MCP env credentials (no cross-contamination)', async () => {
		const ctx = await createTestApp();
		async function projectId(name: string): Promise<string> {
			const co = await createTestTeam(ctx.db, { name });
			const slug = await projectSlugFor(ctx.db, (await co.json()).data.id);
			const p = await ctx.db.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [
				slug,
			]);
			return p.rows[0].id;
		}
		const alpha = await projectId(`Alpha ${Math.random().toString(36).slice(2)}`);
		const bravo = await projectId(`Bravo ${Math.random().toString(36).slice(2)}`);

		for (const [pid, placeholder] of [
			[alpha, '__HEZO_SECRET_YOUTUBE_ALPHA__'],
			[bravo, '__HEZO_SECRET_YOUTUBE_BRAVO__'],
		] as const) {
			await ctx.db.query(
				`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
				 VALUES ('youtube', 'local', $1::jsonb, 'installed', $2)`,
				[
					JSON.stringify({
						command: 'npx',
						args: ['-y', 'youtube-mcp'],
						env: { YOUTUBE_API_KEY: placeholder },
					}),
					pid,
				],
			);
		}

		const alphaDescs = await loadConnectorDescriptors(ctx.db, alpha);
		const alphaYt = alphaDescs.find((d) => d.name === 'youtube');
		if (alphaYt?.kind !== 'stdio') throw new Error('expected stdio descriptor for alpha');
		expect(alphaYt.env?.YOUTUBE_API_KEY).toBe('__HEZO_SECRET_YOUTUBE_ALPHA__');

		const bravoDescs = await loadConnectorDescriptors(ctx.db, bravo);
		const bravoYt = bravoDescs.find((d) => d.name === 'youtube');
		if (bravoYt?.kind !== 'stdio') throw new Error('expected stdio descriptor for bravo');
		expect(bravoYt.env?.YOUTUBE_API_KEY).toBe('__HEZO_SECRET_YOUTUBE_BRAVO__');

		// Cross-contamination guard: neither project's run can see the other's placeholder.
		expect(JSON.stringify(alphaDescs)).not.toContain('YOUTUBE_BRAVO');
		expect(JSON.stringify(bravoDescs)).not.toContain('YOUTUBE_ALPHA');

		await safeClose(ctx.db);
	});
});
