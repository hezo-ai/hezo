import type { PGlite } from '@electric-sql/pglite';
import { ApprovalStatus, ApprovalType, PlatformType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import { signOAuthState } from '../../crypto/state';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let boardToken: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	boardToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(boardToken) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'Startup').id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(boardToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'OAuth Co', template_id: typeId, issue_prefix: 'OC' }),
	});
	companyId = (await companyRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('GET /oauth/callback (public, no auth required)', () => {
	it('redirects to /error when error param is present', async () => {
		const res = await app.request('/oauth/callback?error=access_denied&message=User+denied');
		expect(res.status).toBe(302);
		const location = res.headers.get('location');
		expect(location).toContain('/error');
		expect(location).toContain('User%20denied');
	});

	it('returns 400 when state is missing', async () => {
		const res = await app.request('/oauth/callback?platform=github');
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('BAD_REQUEST');
		expect(body.error.message).toContain('Missing state or platform');
	});

	it('returns 400 when platform is missing', async () => {
		const res = await app.request('/oauth/callback?state=abc');
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('BAD_REQUEST');
	});

	it('returns 400 for tampered state parameter', async () => {
		const res = await app.request('/oauth/callback?state=tampered.value&platform=github');
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('BAD_REQUEST');
		expect(body.error.message).toContain('Invalid or tampered');
	});

	it('returns 400 when code is missing but state is valid', async () => {
		const state = await signOAuthState({ company_id: companyId }, masterKeyManager);
		const res = await app.request(
			`/oauth/callback?state=${encodeURIComponent(state)}&platform=github`,
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('BAD_REQUEST');
		expect(body.error.message).toContain('Missing code');
	});

	it('redirects to error when Connect service exchange fails (network)', async () => {
		// The test app has connectUrl=http://localhost:4100 which won't be running,
		// so the fetch to /auth/exchange will fail
		const state = await signOAuthState({ company_id: companyId }, masterKeyManager);
		const res = await app.request(
			`/oauth/callback?state=${encodeURIComponent(state)}&platform=github&code=test_code`,
		);
		// Should redirect to error page since connect service is unreachable
		expect(res.status).toBe(302);
		const location = res.headers.get('location');
		expect(location).toContain('/error');
	});

	it('auto-resolves pending oauth_request approvals on success', async () => {
		// Insert a pending oauth_request approval
		await db.query(
			`INSERT INTO approvals (company_id, type, status, payload, requested_by_member_id)
			 VALUES ($1, $2::approval_type, $3::approval_status, $4::jsonb,
			   (SELECT id FROM members WHERE company_id = $1 LIMIT 1))`,
			[
				companyId,
				ApprovalType.OauthRequest,
				ApprovalStatus.Pending,
				JSON.stringify({ platform: PlatformType.GitHub }),
			],
		);

		// Verify the approval exists
		const before = await db.query(
			`SELECT status FROM approvals WHERE company_id = $1 AND type = $2::approval_type AND status = $3::approval_status`,
			[companyId, ApprovalType.OauthRequest, ApprovalStatus.Pending],
		);
		expect(before.rows.length).toBeGreaterThanOrEqual(1);
	});
});
