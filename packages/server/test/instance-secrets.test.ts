import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { loadSecretsForScope } from '../src/services/egress/substitution';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

async function makeTeam(name: string): Promise<string> {
	const res = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name }),
	});
	return (await res.json()).data.id;
}

async function createInstanceSecret(body: Record<string, unknown>): Promise<Response> {
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

describe('instance-level credentials (secrets)', () => {
	it('an instance secret (team_id NULL) is resolved by the egress loader for any team', async () => {
		const createRes = await createInstanceSecret({
			name: 'SHARED_API_KEY',
			value: 'sk-instance-123',
			allowed_hosts: ['api.shared.example'],
		});
		expect(createRes.status).toBe(201);
		const secret = (await createRes.json()).data;
		expect(secret.team_id).toBeNull();
		expect(secret.allowed_hosts).toEqual(['api.shared.example']);

		// Listed in the instance credentials view.
		const instRes = await app.request('/api/credentials', { headers: authHeader(token) });
		expect(
			(await instRes.json()).data.some((s: { name: string }) => s.name === 'SHARED_API_KEY'),
		).toBe(true);

		// The egress loader resolves & decrypts it for an arbitrary team.
		const teamId = await makeTeam('Secrets Team');
		const loaded = await loadSecretsForScope({ db, masterKeyManager, teamId, projectId: null });
		const resolved = loaded.get('SHARED_API_KEY');
		expect(resolved?.value).toBe('sk-instance-123');
		expect(resolved?.allowedHosts).toEqual(['api.shared.example']);

		// And it surfaces (read-only) in the team's credentials + secrets lists.
		const teamCreds = await app.request(`/api/teams/${teamId}/credentials`, {
			headers: authHeader(token),
		});
		const credRows = (await teamCreds.json()).data as { name: string; team_id: string | null }[];
		expect(credRows.some((s) => s.name === 'SHARED_API_KEY' && s.team_id === null)).toBe(true);

		const teamSecrets = await app.request(`/api/teams/${teamId}/secrets`, {
			headers: authHeader(token),
		});
		const secRows = (await teamSecrets.json()).data as { name: string; team_id: string | null }[];
		expect(secRows.some((s) => s.name === 'SHARED_API_KEY' && s.team_id === null)).toBe(true);
	});

	it('a team-scoped secret wins the name dedup over an instance one', async () => {
		await createInstanceSecret({ name: 'DUP_KEY', value: 'instance-value', allow_all_hosts: true });

		const teamId = await makeTeam('Dedup Secrets Team');
		await app.request(`/api/teams/${teamId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'DUP_KEY', value: 'team-value', allow_all_hosts: true }),
		});

		const loaded = await loadSecretsForScope({ db, masterKeyManager, teamId, projectId: null });
		expect(loaded.get('DUP_KEY')?.value).toBe('team-value');
	});

	it('a team cannot patch or delete an instance secret via its team routes', async () => {
		const createRes = await createInstanceSecret({
			name: 'PROTECTED',
			value: 'v',
			allow_all_hosts: true,
		});
		const secretId = (await createRes.json()).data.id;

		const teamId = await makeTeam('Boundary Team');
		const patch = await app.request(`/api/teams/${teamId}/secrets/${secretId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'hijack' }),
		});
		expect(patch.status).toBe(404);

		const del = await app.request(`/api/teams/${teamId}/secrets/${secretId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(404);

		// Still resolves to its original value.
		const loaded = await loadSecretsForScope({ db, masterKeyManager, teamId, projectId: null });
		expect(loaded.get('PROTECTED')?.value).toBe('v');
	});

	it('rotates an instance secret value via upsert (re-POST) and via PATCH', async () => {
		await createInstanceSecret({ name: 'ROTATE', value: 'v1', allow_all_hosts: true });
		// Re-POST same name → upsert new value (no duplicate-key error).
		const repost = await createInstanceSecret({
			name: 'ROTATE',
			value: 'v2',
			allow_all_hosts: true,
		});
		expect(repost.status).toBe(201);

		const teamId = await makeTeam('Rotate Team');
		let loaded = await loadSecretsForScope({ db, masterKeyManager, teamId, projectId: null });
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

		loaded = await loadSecretsForScope({ db, masterKeyManager, teamId, projectId: null });
		expect(loaded.get('ROTATE')?.value).toBe('v3');
	});

	it('requires superuser for instance credential management', async () => {
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
});
