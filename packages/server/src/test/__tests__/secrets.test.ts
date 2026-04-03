import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;
let agentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	// Create a company with agents
	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find((t: any) => t.is_builtin).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Secret Co',
			team_type_ids: [typeId],
			issue_prefix: 'SC',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	// Get an agent ID
	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('secrets CRUD', () => {
	let secretId: string;

	it('creates a secret (value encrypted)', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'GITHUB_TOKEN',
				value: 'ghp_abc123',
				category: 'api_token',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.name).toBe('GITHUB_TOKEN');
		expect(body.data.category).toBe('api_token');
		// Value should NOT be returned
		expect(body.data).not.toHaveProperty('encrypted_value');
		expect(body.data).not.toHaveProperty('value');
		secretId = body.data.id;
	});

	it('lists secrets (no values)', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBeGreaterThanOrEqual(1);
		expect(body.data[0]).toHaveProperty('grant_count');
		expect(body.data[0]).not.toHaveProperty('encrypted_value');
	});

	it('creates and revokes a secret grant', async () => {
		// Create grant
		const grantRes = await app.request(`/api/companies/${companyId}/secrets/${secretId}/grants`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ agent_id: agentId, scope: 'single' }),
		});
		expect(grantRes.status).toBe(201);
		const grant = (await grantRes.json()).data;
		expect(grant.scope).toBe('single');

		// List grants
		const listRes = await app.request(`/api/companies/${companyId}/secrets/${secretId}/grants`, {
			headers: authHeader(token),
		});
		expect((await listRes.json()).data).toHaveLength(1);

		// Revoke
		const revokeRes = await app.request(`/api/companies/${companyId}/secret-grants/${grant.id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(revokeRes.status).toBe(200);
		const revoked = (await revokeRes.json()).data;
		expect(revoked.revoked_at).not.toBeNull();
	});

	it('deletes a secret', async () => {
		const res = await app.request(`/api/companies/${companyId}/secrets/${secretId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
	});
});
