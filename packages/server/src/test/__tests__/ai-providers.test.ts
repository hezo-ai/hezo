import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../lib/types';
import { signBoardJwt } from '../../middleware/auth';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let nonSuperuserToken: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Board', false) RETURNING id",
	);
	nonSuperuserToken = await signBoardJwt(ctx.masterKeyManager, nonAdmin.rows[0].id);
});

beforeEach(() => {
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(async () => {
	await safeClose(db);
});

describe('AI providers status', () => {
	it('returns configured: false when no providers exist', async () => {
		const res = await app.request('/api/ai-providers/status', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.configured).toBe(false);
		expect(body.data.providers).toEqual([]);
	});
});

describe('AI providers CRUD', () => {
	let configId: string;

	it('adds an API key for anthropic', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-test-key-12345',
				label: 'anthropic-primary',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.id).toBeDefined();
		configId = body.data.id;
	});

	it('lists configured providers without exposing key values', async () => {
		const res = await app.request('/api/ai-providers', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].provider).toBe('anthropic');
		expect(body.data[0].label).toBe('anthropic-primary');
		expect(body.data[0].is_default).toBe(true);
		expect(body.data[0].auth_method).toBe('api_key');
		expect(body.data[0]).not.toHaveProperty('api_key');
		expect(body.data[0]).not.toHaveProperty('encrypted_credential');
	});

	it('returns configured: true after adding a provider', async () => {
		const res = await app.request('/api/ai-providers/status', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.configured).toBe(true);
		expect(body.data.providers).toContain('anthropic');
	});

	it('rejects invalid provider name', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'invalid', api_key: 'test' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects empty API key', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'openai', api_key: '' }),
		});
		expect(res.status).toBe(400);
	});

	it('adds a second provider (openai)', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'sk-openai-test-key-12345',
			}),
		});
		expect(res.status).toBe(201);
	});

	it('lists both providers', async () => {
		const res = await app.request('/api/ai-providers', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBe(2);
	});

	it('deletes a provider config', async () => {
		const res = await app.request(`/api/ai-providers/${configId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.deleted).toBe(true);

		const listRes = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const body = await listRes.json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].provider).toBe('openai');
	});

	it('returns 404 for non-existent config deletion', async () => {
		const res = await app.request('/api/ai-providers/00000000-0000-0000-0000-000000000000', {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});
});

describe('AI providers authorization', () => {
	it('rejects unauthenticated requests', async () => {
		const res = await app.request('/api/ai-providers');
		expect(res.status).toBe(401);
	});

	it('allows non-superuser board members to read the status', async () => {
		const res = await app.request('/api/ai-providers/status', {
			headers: authHeader(nonSuperuserToken),
		});
		expect(res.status).toBe(200);
	});

	it('rejects non-superusers from creating configs', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(nonSuperuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'moonshot', api_key: 'moonshot-key' }),
		});
		expect(res.status).toBe(403);
	});
});

describe('AI providers key format validation', () => {
	it('rejects anthropic keys without sk-ant- prefix', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'invalid-key-format',
				label: 'bad-format',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_KEY_FORMAT');
	});

	it('accepts moonshot keys without prefix check', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'moonshot',
				api_key: 'any-key-format-is-fine',
				label: 'moonshot-primary',
			}),
		});
		expect(res.status).toBe(201);
	});
});

describe('AI providers key validation against provider API', () => {
	it('rejects a key that the provider says is invalid', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;

		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-invalid-key',
				label: 'invalid-anthropic',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_KEY');
	});

	it('returns 503 when the provider is unreachable', async () => {
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error('Network error')) as unknown as unknown as typeof fetch;

		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'sk-unreachable-key',
				label: 'unreachable-openai',
			}),
		});
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error.code).toBe('VALIDATION_FAILED');
	});

	it('stores the key when provider confirms it is valid', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'google',
				api_key: 'AIza-valid-test-key',
				label: 'google-primary',
			}),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.id).toBeDefined();
	});
});

describe('AI providers default-per-provider invariant', () => {
	it('enforces exactly one default per provider after setting a new default', async () => {
		await db.query('DELETE FROM ai_provider_configs');

		const first = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-first',
				label: 'anthropic-a',
			}),
		});
		const firstId = (await first.json()).data.id;

		const second = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-second',
				label: 'anthropic-b',
			}),
		});
		const secondId = (await second.json()).data.id;

		const promote = await app.request(`/api/ai-providers/${secondId}/default`, {
			method: 'PATCH',
			headers: authHeader(token),
		});
		expect(promote.status).toBe(200);

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const configs = (await list.json()).data as Array<{
			id: string;
			provider: string;
			is_default: boolean;
		}>;
		const anthropicConfigs = configs.filter((c) => c.provider === 'anthropic');
		const defaults = anthropicConfigs.filter((c) => c.is_default);
		expect(defaults.length).toBe(1);
		expect(defaults[0].id).toBe(secondId);
		expect(anthropicConfigs.find((c) => c.id === firstId)?.is_default).toBe(false);
	});
});
