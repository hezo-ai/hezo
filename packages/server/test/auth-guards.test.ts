import { AuthType } from '@hezo/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AuthInfo, Env } from '../src/lib/types';
import { validateBody } from '../src/lib/validate';
import { requireAdmin, requireAdminAuth, requireRole } from '../src/middleware/auth';

const ADMIN: AuthInfo = { type: AuthType.Admin, userId: 'u1', isSuperuser: false };
const AGENT: AuthInfo = {
	type: AuthType.Agent,
	memberId: 'm1',
	teamId: 't1',
	runId: 'r1',
	taskId: null,
	projectId: 'p1',
	crossProject: false,
};
const API_KEY: AuthInfo = { type: AuthType.ApiKey, teamId: 't1' };

function appWithAuth(auth: AuthInfo): Hono<Env> {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('auth', auth);
		return next();
	});
	app.get('/role-admin', (c) => {
		const denied = requireRole(c, [AuthType.Admin]);
		if (denied) return denied;
		return c.json({ ok: true });
	});
	app.get('/admin', (c) => {
		const denied = requireAdmin(c, 'Only the admin have an inbox');
		if (denied) return denied;
		return c.json({ ok: true });
	});
	app.get('/admin-auth', (c) => {
		const a = requireAdminAuth(c);
		if (a instanceof Response) return a;
		return c.json({ userId: a.userId });
	});
	app.post('/validate', async (c) => {
		const parsed = await validateBody(c, z.object({ name: z.string().min(1) }));
		if (parsed instanceof Response) return parsed;
		return c.json({ name: parsed.name });
	});
	return app;
}

describe('requireRole / requireAdmin', () => {
	it('allows the matching role', async () => {
		const res = await appWithAuth(ADMIN).request('/admin');
		expect(res.status).toBe(200);
	});

	it('denies a non-matching role with 403 FORBIDDEN', async () => {
		for (const auth of [AGENT, API_KEY]) {
			const res = await appWithAuth(auth).request('/admin');
			expect(res.status).toBe(403);
			const body = (await res.json()) as { error: { code: string; message: string } };
			expect(body.error.code).toBe('FORBIDDEN');
			expect(body.error.message).toBe('Only the admin have an inbox');
		}
	});

	it('requireRole honors the allowed-types list', async () => {
		expect((await appWithAuth(ADMIN).request('/role-admin')).status).toBe(200);
		expect((await appWithAuth(AGENT).request('/role-admin')).status).toBe(403);
	});
});

describe('requireAdminAuth', () => {
	it('returns the narrowed admin auth on success', async () => {
		const res = await appWithAuth(ADMIN).request('/admin-auth');
		expect(res.status).toBe(200);
		expect((await res.json()) as { userId: string }).toEqual({ userId: 'u1' });
	});

	it('returns a 403 Response for non-admin principals', async () => {
		const res = await appWithAuth(AGENT).request('/admin-auth');
		expect(res.status).toBe(403);
	});
});

describe('validateBody', () => {
	it('returns the parsed value for a valid body', async () => {
		const res = await appWithAuth(ADMIN).request('/validate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'hello' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { name: string }).toEqual({ name: 'hello' });
	});

	it('rejects an invalid body with 400 INVALID_REQUEST and the field path', async () => {
		const res = await appWithAuth(ADMIN).request('/validate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: '' }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe('INVALID_REQUEST');
		expect(body.error.message).toContain('name');
	});

	it('rejects a non-JSON body with 400', async () => {
		const res = await appWithAuth(ADMIN).request('/validate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not json',
		});
		expect(res.status).toBe(400);
	});
});
