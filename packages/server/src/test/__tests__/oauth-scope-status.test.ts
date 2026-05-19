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

async function insertConnection(provider: string, scopes: string[]): Promise<string> {
	const secret = await db.query<{ id: string }>(
		`INSERT INTO secrets (company_id, name, encrypted_value, category, allowed_hosts)
		 VALUES ($1, $2, 'placeholder', 'api_token', ARRAY['github.com'])
		 RETURNING id`,
		[companyId, `OAUTH_${provider.toUpperCase()}_${Math.random().toString(16).slice(2, 10)}`],
	);
	const conn = await db.query<{ id: string }>(
		`INSERT INTO oauth_connections (company_id, provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id`,
		[
			companyId,
			provider,
			Math.random().toString(16).slice(2, 10),
			'octo',
			secret.rows[0].id,
			scopes,
		],
	);
	return conn.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Scope Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /api/companies/:companyId/oauth-connections/:id/scope-status', () => {
	it('reports sufficient=false with the missing scope when only repo is granted', async () => {
		const connId = await insertConnection('github', ['repo']);
		const res = await app.request(
			`/api/companies/${companyId}/oauth-connections/${connId}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { sufficient: boolean; missing: string[]; required: string[] };
		};
		expect(body.data.sufficient).toBe(false);
		expect(body.data.missing).toEqual(['read:org']);
		expect(body.data.required).toEqual(['repo', 'read:org']);
	});

	it('reports sufficient=true when the minimum set is granted', async () => {
		const connId = await insertConnection('github', ['repo', 'read:org']);
		const res = await app.request(
			`/api/companies/${companyId}/oauth-connections/${connId}/scope-status`,
			{ headers: authHeader(token) },
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
		]);
		const res = await app.request(
			`/api/companies/${companyId}/oauth-connections/${connId}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { sufficient: boolean } };
		expect(body.data.sufficient).toBe(true);
	});

	it('rejects scope-status for a non-github connection', async () => {
		const connId = await insertConnection('linear', ['read', 'write']);
		const res = await app.request(
			`/api/companies/${companyId}/oauth-connections/${connId}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(400);
	});

	it('404s when the connection does not exist for this company', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/oauth-connections/00000000-0000-0000-0000-000000000000/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});

	it("isolates cross-company: another company's connection 404s on this company's route", async () => {
		const otherTypesRes = await app.request('/api/company-types', { headers: authHeader(token) });
		const otherTypeId = (await otherTypesRes.json()).data[0].id;
		const otherCompanyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Other Scope Co', template_id: otherTypeId }),
		});
		const otherCompanyId = (await otherCompanyRes.json()).data.id;

		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (company_id, name, encrypted_value, category, allowed_hosts)
			 VALUES ($1, 'OAUTH_GITHUB_OTHER', 'placeholder', 'api_token', ARRAY['github.com'])
			 RETURNING id`,
			[otherCompanyId],
		);
		const conn = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections (company_id, provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
			 VALUES ($1, 'github', '111', 'outsider', $2, ARRAY['repo','read:org'])
			 RETURNING id`,
			[otherCompanyId, secret.rows[0].id],
		);

		const res = await app.request(
			`/api/companies/${companyId}/oauth-connections/${conn.rows[0].id}/scope-status`,
			{ headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});
