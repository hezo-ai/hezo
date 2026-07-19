import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { loadAllSecrets } from '../src/services/egress/substitution';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;

async function createSecret(body: Record<string, unknown>): Promise<Response> {
	return app.request('/api/secrets', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
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

describe('global credentials (secrets)', () => {
	it('a global secret is resolved & decrypted by the egress loader for any run', async () => {
		const createRes = await createSecret({
			name: 'SHARED_API_KEY',
			value: 'sk-instance-123',
			allowed_hosts: ['api.shared.example'],
		});
		expect(createRes.status).toBe(201);
		const secret = (await createRes.json()).data;
		expect(secret.allowed_hosts).toEqual(['api.shared.example']);

		// Listed in the global credentials view.
		const instRes = await app.request('/api/credentials', { headers: authHeader(token) });
		expect(
			(await instRes.json()).data.some((s: { name: string }) => s.name === 'SHARED_API_KEY'),
		).toBe(true);

		// The egress loader resolves & decrypts it — no team/project scope.
		const loaded = await loadAllSecrets({ db, masterKeyManager });
		const resolved = loaded.get('SHARED_API_KEY');
		expect(resolved?.value).toBe('sk-instance-123');
		expect(resolved?.allowedHosts).toEqual(['api.shared.example']);
	});

	it('paginates the credentials list with offset + total meta', async () => {
		for (const name of ['PAGE_1', 'PAGE_2', 'PAGE_3']) {
			expect((await createSecret({ name, value: 'v', allow_all_hosts: true })).status).toBe(201);
		}

		const all = await app.request('/api/credentials?per_page=200', { headers: authHeader(token) });
		const total = (await all.json()).meta.total as number;
		expect(total).toBeGreaterThanOrEqual(3);

		const p1 = await app.request('/api/credentials?page=1&per_page=2', {
			headers: authHeader(token),
		});
		const b1 = await p1.json();
		expect(b1.meta).toEqual({ page: 1, per_page: 2, total });
		expect(b1.data).toHaveLength(2);

		const p2 = await app.request('/api/credentials?page=2&per_page=2', {
			headers: authHeader(token),
		});
		const b2 = await p2.json();
		expect(b2.meta.page).toBe(2);
		const ids1 = b1.data.map((s: { id: string }) => s.id);
		const ids2 = b2.data.map((s: { id: string }) => s.id);
		expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
	});

	it('secret names are unique instance-wide; re-POST rotates the value', async () => {
		await createSecret({ name: 'ROTATE', value: 'v1', allow_all_hosts: true });
		// Re-POST same name → upsert new value (no duplicate-key error).
		const repost = await createSecret({ name: 'ROTATE', value: 'v2', allow_all_hosts: true });
		expect(repost.status).toBe(201);

		let loaded = await loadAllSecrets({ db, masterKeyManager });
		expect(loaded.get('ROTATE')?.value).toBe('v2');

		const instList = await app.request('/api/credentials', { headers: authHeader(token) });
		const row = (await instList.json()).data.find((s: { name: string }) => s.name === 'ROTATE') as {
			id: string;
		};
		const patch = await app.request(`/api/secrets/${row.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'v3' }),
		});
		expect(patch.status).toBe(200);

		loaded = await loadAllSecrets({ db, masterKeyManager });
		expect(loaded.get('ROTATE')?.value).toBe('v3');
	});

	it('deletes a secret so the egress loader no longer resolves it', async () => {
		const createRes = await createSecret({ name: 'EPHEMERAL', value: 'x', allow_all_hosts: true });
		const secretId = (await createRes.json()).data.id;

		let loaded = await loadAllSecrets({ db, masterKeyManager });
		expect(loaded.has('EPHEMERAL')).toBe(true);

		const del = await app.request(`/api/secrets/${secretId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);

		loaded = await loadAllSecrets({ db, masterKeyManager });
		expect(loaded.has('EPHEMERAL')).toBe(false);
	});

	it('requires superuser for credential management', async () => {
		const nonSuper = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Member', false) RETURNING id",
		);
		const memberToken = await signAdminJwt(masterKeyManager, nonSuper.rows[0].id);

		const listRes = await app.request('/api/credentials', { headers: authHeader(memberToken) });
		expect(listRes.status).toBe(403);

		const postRes = await app.request('/api/secrets', {
			method: 'POST',
			headers: { ...authHeader(memberToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'NOPE', value: 'x', allow_all_hosts: true }),
		});
		expect(postRes.status).toBe(403);
	});

	it('rejects create when name or value is missing', async () => {
		const noName = await createSecret({ value: 'x', allow_all_hosts: true });
		expect(noName.status).toBe(400);
		const noValue = await createSecret({ name: 'NO_VALUE', allow_all_hosts: true });
		expect(noValue.status).toBe(400);
		const blankName = await createSecret({ name: '   ', value: 'x', allow_all_hosts: true });
		expect(blankName.status).toBe(400);
	});

	it('rejects names the egress proxy could never reference', async () => {
		// These would store a secret no canonical placeholder can match —
		// silently un-substitutable. The admin route must reject them, matching
		// request_credential's validation.
		for (const name of ['stripe-key', 'lowercase', '1LEADING', '_LEADING', 'A'.repeat(65)]) {
			const res = await createSecret({ name, value: 'x', allow_all_hosts: true });
			expect(res.status, `name ${name} should be rejected`).toBe(400);
		}
	});

	it('normalizes allowed_hosts (trim, lowercase, drop empties) on create and patch', async () => {
		const createRes = await createSecret({
			name: 'NORMALIZED_HOST',
			value: 'v',
			allowed_hosts: [' API.Example.COM ', '', '   ', 'b.example'],
		});
		expect(createRes.status).toBe(201);
		const created = (await createRes.json()).data;
		expect(created.allowed_hosts).toEqual(['api.example.com', 'b.example']);

		const patch = await app.request(`/api/secrets/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ allowed_hosts: ['  C.EXAMPLE  ', ''] }),
		});
		expect(patch.status).toBe(200);
		expect((await patch.json()).data.allowed_hosts).toEqual(['c.example']);

		// The egress loader sees the cleaned entries, so the host match works.
		const loaded = await loadAllSecrets({ db, masterKeyManager });
		expect(loaded.get('NORMALIZED_HOST')?.allowedHosts).toEqual(['c.example']);
	});

	it('returns 404 when patching or deleting a non-existent secret', async () => {
		const fakeId = '00000000-0000-0000-0000-000000000000';
		const patch = await app.request(`/api/secrets/${fakeId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'x' }),
		});
		expect(patch.status).toBe(404);
		const del = await app.request(`/api/secrets/${fakeId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(404);
	});
});

describe('credential ↔ connector relationships', () => {
	// Seed a project + a connector whose api_key_secret_id points at `secretId`.
	async function seedConnectorUsing(
		secretId: string,
		opts: { projectScoped: boolean } = { projectScoped: true },
	): Promise<{ connectorId: string; projectId: string | null; projectSlug: string | null }> {
		const suffix = Math.random().toString(36).slice(2, 8);
		const team = await db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $2) RETURNING id`,
			[`Rel ${suffix}`, `rel-${suffix}`],
		);
		const proj = await db.query<{ id: string; slug: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, docker_base_image, container_status)
			 VALUES ($1, $2, $3, 'RP', 'hezo/agent-base:latest', NULL) RETURNING id, slug`,
			[team.rows[0].id, `Rel Proj ${suffix}`, `rel-proj-${suffix}`],
		);
		const projectId = opts.projectScoped ? proj.rows[0].id : null;
		const conn = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status, project_id, api_key_secret_id, activated_at)
			 VALUES ($1, 'saas', '{"url":"https://mcp.rel.example/mcp"}'::jsonb, 'installed', $2, $3, now())
			 RETURNING id`,
			[`rel-connector-${suffix}`, projectId, secretId],
		);
		return {
			connectorId: conn.rows[0].id,
			projectId,
			projectSlug: opts.projectScoped ? proj.rows[0].slug : null,
		};
	}

	it('GET /credentials lists the connectors that use each credential', async () => {
		const create = await createSecret({
			name: 'REL_LINKED_KEY',
			value: 'v',
			allowed_hosts: ['mcp.rel.example'],
		});
		const secretId = (await create.json()).data.id as string;
		const { connectorId, projectId, projectSlug } = await seedConnectorUsing(secretId);

		const res = await app.request('/api/credentials', { headers: authHeader(token) });
		const rows = (await res.json()).data as {
			id: string;
			name: string;
			connectors: {
				id: string;
				name: string;
				project_id: string | null;
				project_slug: string | null;
			}[];
		}[];
		const linked = rows.find((r) => r.name === 'REL_LINKED_KEY');
		expect(linked).toBeDefined();
		expect(linked?.connectors).toHaveLength(1);
		expect(linked?.connectors[0]).toMatchObject({
			id: connectorId,
			project_id: projectId,
			project_slug: projectSlug,
		});

		// A credential with no connector reports an empty array.
		const unused = rows.find((r) => r.name === 'SHARED_API_KEY');
		expect(unused?.connectors).toEqual([]);
	});

	it('blocks deleting a credential that is in use by a connector (409), allows it once free', async () => {
		const create = await createSecret({
			name: 'REL_GUARDED_KEY',
			value: 'v',
			allowed_hosts: ['mcp.rel.example'],
		});
		const secretId = (await create.json()).data.id as string;
		const { connectorId } = await seedConnectorUsing(secretId);

		const blocked = await app.request(`/api/secrets/${secretId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(blocked.status).toBe(409);

		// Detach the connector, then the delete is allowed.
		await db.query(`DELETE FROM mcp_connections WHERE id = $1`, [connectorId]);
		const allowed = await app.request(`/api/secrets/${secretId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(allowed.status).toBe(200);
	});
});
