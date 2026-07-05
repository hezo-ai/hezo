import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

/**
 * Covers the AI-provider verify endpoint and the duplicate-config branch that
 * ai-providers.test.ts doesn't reach: POST /ai-providers/:configId/verify
 * (valid / invalid-and-marked / unreachable / authorization / 404), and the 409
 * DUPLICATE path when a provider+label collides. The provider HTTP call is
 * stubbed via globalThis.fetch; key-format validation on add is bypassed with
 * SKIP_AI_KEY_VALIDATION so setup is deterministic.
 */

let app: Hono<Env>;
let db: Db;
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
		"INSERT INTO users (display_name, is_superuser) VALUES ('Plain Admin', false) RETURNING id",
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

// deepseek has no key-prefix constraint, so a free-form key is accepted even
// though the prefix check still runs under SKIP_AI_KEY_VALIDATION.
async function addProvider(provider: string, apiKey: string, label: string): Promise<string> {
	const res = await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ provider, api_key: apiKey, label }),
	});
	if (res.status !== 201) throw new Error(`addProvider failed: ${res.status}`);
	return (await res.json()).data.id;
}

describe('POST /ai-providers/:configId/verify', () => {
	let configId: string;

	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
		configId = await addProvider('deepseek', 'sk-deepseek-verify', 'verify-target');
	});

	it('returns valid:true when the provider accepts the key', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		const res = await app.request(`/api/ai-providers/${configId}/verify`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.valid).toBe(true);
	});

	it('returns valid:false and marks the config invalid when the provider rejects', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
		const res = await app.request(`/api/ai-providers/${configId}/verify`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.valid).toBe(false);
		expect(body.data.message).toContain('invalid');

		const status = await db.query<{ status: string }>(
			'SELECT status FROM ai_provider_configs WHERE id = $1',
			[configId],
		);
		expect(status.rows[0].status).toBe('invalid');
	});

	it('returns valid:false when the provider is unreachable', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('net')) as unknown as typeof fetch;
		const res = await app.request(`/api/ai-providers/${configId}/verify`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.valid).toBe(false);
		expect(body.data.message).toContain('Could not reach provider');
	});

	it('returns 404 for an unknown config id', async () => {
		const res = await app.request('/api/ai-providers/00000000-0000-0000-0000-000000000000/verify', {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('rejects a non-superuser', async () => {
		const res = await app.request(`/api/ai-providers/${configId}/verify`, {
			method: 'POST',
			headers: authHeader(nonSuperuserToken),
		});
		expect(res.status).toBe(403);
	});

	it('treats a subscription config as always valid without an HTTP call', async () => {
		await db.query('DELETE FROM ai_provider_configs');
		const create = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-oat01-live-token',
				auth_method: 'subscription',
				label: 'sub-verify',
			}),
		});
		expect(create.status).toBe(201);
		const subId = (await create.json()).data.id;

		const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500 });
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const res = await app.request(`/api/ai-providers/${subId}/verify`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.valid).toBe(true);
		// Subscription auth short-circuits before any provider HTTP call.
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('POST /ai-providers duplicate handling', () => {
	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
	});

	it('returns 409 DUPLICATE when the same provider+label is added twice', async () => {
		const first = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'openai', api_key: 'sk-dup-1', label: 'dup-label' }),
		});
		expect(first.status).toBe(201);

		const second = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'openai', api_key: 'sk-dup-2', label: 'dup-label' }),
		});
		expect(second.status).toBe(409);
		expect((await second.json()).error.code).toBe('DUPLICATE');
	});
});
