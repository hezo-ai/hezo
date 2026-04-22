import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let company2Id: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'UI State Co' }),
	});
	companyId = (await companyRes.json()).data.id;

	const company2Res = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'UI State Co 2' }),
	});
	company2Id = (await company2Res.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('UI state', () => {
	it('GET returns empty object when no settings set', async () => {
		const res = await app.request(`/api/companies/${companyId}/ui-state`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual({});
	});

	it('PATCH sets sidebar.team_expanded', async () => {
		const res = await app.request(`/api/companies/${companyId}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ sidebar: { team_expanded: false } }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.sidebar.team_expanded).toBe(false);
	});

	it('GET returns persisted state after PATCH', async () => {
		const res = await app.request(`/api/companies/${companyId}/ui-state`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.sidebar.team_expanded).toBe(false);
	});

	it('PATCH merges state without replacing other keys', async () => {
		await app.request(`/api/companies/${companyId}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ other_setting: 'hello' }),
		});

		const res = await app.request(`/api/companies/${companyId}/ui-state`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		expect(body.data.sidebar.team_expanded).toBe(false);
		expect(body.data.other_setting).toBe('hello');
	});

	it('PATCH updates existing nested value', async () => {
		const res = await app.request(`/api/companies/${companyId}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ sidebar: { team_expanded: true } }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.sidebar.team_expanded).toBe(true);
	});

	it('state is per-company', async () => {
		await app.request(`/api/companies/${company2Id}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ sidebar: { team_expanded: false } }),
		});

		const res1 = await app.request(`/api/companies/${companyId}/ui-state`, {
			headers: authHeader(token),
		});
		const body1 = await res1.json();
		expect(body1.data.sidebar.team_expanded).toBe(true);

		const res2 = await app.request(`/api/companies/${company2Id}/ui-state`, {
			headers: authHeader(token),
		});
		const body2 = await res2.json();
		expect(body2.data.sidebar.team_expanded).toBe(false);
	});

	it('rejects agent auth with 403', async () => {
		const agentRes = await app.request(`/api/companies/${companyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Test Agent' }),
		});
		const agentId = (await agentRes.json()).data.id;
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId);

		const getRes = await app.request(`/api/companies/${companyId}/ui-state`, {
			headers: authHeader(agentToken),
		});
		expect(getRes.status).toBe(403);

		const patchRes = await app.request(`/api/companies/${companyId}/ui-state`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ sidebar: { team_expanded: false } }),
		});
		expect(patchRes.status).toBe(403);
	});

	it('rejects access to company user is not a member of', async () => {
		const res = await app.request('/api/companies/00000000-0000-0000-0000-000000000000/ui-state', {
			headers: authHeader(token),
		});
		// Superuser bypasses company access check but has no member_users row
		expect(res.status).toBe(403);
	});
});
