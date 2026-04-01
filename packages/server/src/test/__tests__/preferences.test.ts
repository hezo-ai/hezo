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

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Pref Test Co', issue_prefix: 'PTC' }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('Company preferences', () => {
	it('returns null when no preferences exist', async () => {
		const res = await app.request(`/api/companies/${companyId}/preferences`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toBeNull();
	});

	it('creates preferences on first PATCH', async () => {
		const res = await app.request(`/api/companies/${companyId}/preferences`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: '# Preferences\n\nPrefer functional patterns.',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.content).toContain('functional patterns');
	});

	it('reads preferences after creation', async () => {
		const res = await app.request(`/api/companies/${companyId}/preferences`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('functional patterns');
	});

	it('updates preferences and creates revision', async () => {
		const res = await app.request(`/api/companies/${companyId}/preferences`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content: '# Preferences\n\nPrefer functional patterns.\nUse dark themes.',
				change_summary: 'Added dark themes preference',
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.content).toContain('dark themes');

		// Check revision was created with previous content
		const revRes = await app.request(`/api/companies/${companyId}/preferences/revisions`, {
			headers: authHeader(token),
		});
		expect(revRes.status).toBe(200);
		const revBody = await revRes.json();
		expect(revBody.data.length).toBe(1);
		expect(revBody.data[0].content).toContain('functional patterns');
		expect(revBody.data[0].content).not.toContain('dark themes');
		expect(revBody.data[0].change_summary).toBe('Added dark themes preference');
	});

	it('returns empty revisions when no preferences exist', async () => {
		// Create a new company with no preferences
		const coRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Empty Prefs Co', issue_prefix: 'EPC' }),
		});
		const emptyCoId = (await coRes.json()).data.id;

		const res = await app.request(`/api/companies/${emptyCoId}/preferences/revisions`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});
});
