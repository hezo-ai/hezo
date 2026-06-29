import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

/**
 * Branch-coverage tests for packages/server/src/routes/ai-providers.ts. Targets
 * paths the happy-path suites (ai-providers.test.ts, ai-providers-verify.test.ts)
 * don't reach: the missing-provider POST branch, the PATCH "nothing to update"
 * 400, PATCH default_model coercion of a non-string, the models endpoint's
 * non-401 provider-error and unparseable-response branches, and the
 * authorization (403) gates on verify / delete / models / PATCH.
 *
 * SKIP_AI_KEY_VALIDATION makes the add path deterministic without a live
 * provider; the provider HTTP call is stubbed via globalThis.fetch.
 */

let app: Hono<Env>;
let db: PGlite;
let token: string;
let nonSuperuserToken: string;

const originalFetch = globalThis.fetch;
let prevSkip: string | undefined;

beforeAll(async () => {
	prevSkip = process.env.SKIP_AI_KEY_VALIDATION;
	process.env.SKIP_AI_KEY_VALIDATION = '1';

	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Plain Admin Cov', false) RETURNING id",
	);
	nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

beforeEach(() => {
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(async () => {
	process.env.SKIP_AI_KEY_VALIDATION = prevSkip;
	await safeClose(db);
});

async function addProvider(provider: string, apiKey: string, label: string): Promise<string> {
	const res = await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ provider, api_key: apiKey, label }),
	});
	if (res.status !== 201) throw new Error(`addProvider failed: ${res.status}`);
	return (await res.json()).data.id;
}

describe('POST /ai-providers input branches', () => {
	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
	});

	it('rejects a missing provider field (no provider supplied)', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ api_key: 'sk-whatever' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_PROVIDER');
	});

	it('rejects a whitespace-only api_key', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'openai', api_key: '   ' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe('INVALID_REQUEST');
	});
});

describe('PATCH /ai-providers/:configId branches', () => {
	let configId: string;

	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
		configId = await addProvider('deepseek', 'sk-deepseek-patch', 'patch-target');
	});

	it('rejects a body with no default_model field (nothing to update)', async () => {
		const res = await app.request(`/api/ai-providers/${configId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ unrelated: 'x' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/Nothing to update/);
	});

	it('coerces a blank-string default_model to null', async () => {
		const res = await app.request(`/api/ai-providers/${configId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_model: '   ' }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.default_model).toBeNull();
	});

	it('coerces a non-string default_model to null', async () => {
		const res = await app.request(`/api/ai-providers/${configId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_model: 42 }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.default_model).toBeNull();
	});
});

describe('DELETE / verify / models authorization (403)', () => {
	let configId: string;

	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
		configId = await addProvider('deepseek', 'sk-deepseek-authz', 'authz-target');
	});

	it('DELETE rejects a non-superuser with 403', async () => {
		const res = await app.request(`/api/ai-providers/${configId}`, {
			method: 'DELETE',
			headers: authHeader(nonSuperuserToken),
		});
		expect(res.status).toBe(403);
	});

	it('verify rejects a non-superuser with 403', async () => {
		const res = await app.request(`/api/ai-providers/${configId}/verify`, {
			method: 'POST',
			headers: authHeader(nonSuperuserToken),
		});
		expect(res.status).toBe(403);
	});

	it('PATCH /default rejects a non-superuser with 403', async () => {
		const res = await app.request(`/api/ai-providers/${configId}/default`, {
			method: 'PATCH',
			headers: authHeader(nonSuperuserToken),
		});
		expect(res.status).toBe(403);
	});

	it('PATCH /default 404s for an unknown config', async () => {
		const res = await app.request(
			'/api/ai-providers/00000000-0000-0000-0000-000000000000/default',
			{ method: 'PATCH', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('GET /ai-providers/:configId/models provider-response branches', () => {
	let configId: string;

	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
		configId = await addProvider('openai', 'sk-openai-models-cov', 'models-cov');
	});

	it('maps a non-401/403 provider failure to PROVIDER_ERROR 503', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(503);
		expect((await res.json()).error.code).toBe('PROVIDER_ERROR');
	});

	it('maps a 403 provider failure to INVALID_KEY 401', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(401);
		expect((await res.json()).error.code).toBe('INVALID_KEY');
	});

	it('maps an unparseable provider body to PROVIDER_ERROR 503', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => {
				throw new Error('bad json');
			},
		}) as unknown as typeof fetch;
		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error.code).toBe('PROVIDER_ERROR');
		expect(body.error.message).toMatch(/unparseable/);
	});
});
