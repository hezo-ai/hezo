import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, projectSlugFor } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectSlug: string;

async function insertConnection(provider: string, scopes: string[]): Promise<string> {
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, 'placeholder', 'api_token', ARRAY['github.com'])
		 RETURNING id`,
		[`OAUTH_${provider.toUpperCase()}_${Math.random().toString(16).slice(2, 10)}`],
	);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[provider, Math.random().toString(16).slice(2, 10), 'octo', secret.rows[0].id, scopes],
	);
	return conn.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Scope Co', template_id: typeId }),
	});
	const team = (await teamRes.json()).data as { id: string; slug: string };
	teamId = team.id;
	projectSlug = `${await projectSlugFor(db, team.id)}`;
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /api/projects/:projectId/oauth-connections/:id/scope-status', () => {
	it('reports sufficient=false with the missing scopes when only repo is granted', async () => {
		const connId = await insertConnection('github', ['repo']);
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${connId}/scope-status`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { sufficient: boolean; missing: string[]; required: string[] };
		};
		expect(body.data.sufficient).toBe(false);
		expect(body.data.missing).toEqual(['read:org', 'write:public_key']);
		expect(body.data.required).toEqual(['repo', 'read:org', 'write:public_key']);
	});

	it('reports sufficient=true when the minimum set is granted', async () => {
		const connId = await insertConnection('github', ['repo', 'read:org', 'write:public_key']);
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${connId}/scope-status`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { sufficient: boolean; missing: string[] } };
		expect(body.data.sufficient).toBe(true);
		expect(body.data.missing).toEqual([]);
	});

	it('reports sufficient=true for a connection with a superset of scopes', async () => {
		const connId = await insertConnection('github', [
			'repo',
			'read:org',
			'workflow',
			'write:ssh_signing_key',
			'write:public_key',
		]);
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${connId}/scope-status`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { sufficient: boolean } };
		expect(body.data.sufficient).toBe(true);
	});

	it('rejects scope-status for a non-github connection', async () => {
		const connId = await insertConnection('linear', ['read', 'write']);
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/${connId}/scope-status`,
			{
				headers: authHeader(token),
			},
		);
		expect(res.status).toBe(400);
	});

	it('404s when the connection does not exist for this team', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/oauth-connections/00000000-0000-0000-0000-000000000000/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});
