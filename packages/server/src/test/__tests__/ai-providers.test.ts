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

describe('AI providers default model', () => {
	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
	});

	it('returns default_model null on list when not set', async () => {
		const create = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-default-model',
				label: 'anthropic-dm',
			}),
		});
		expect(create.status).toBe(201);

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const body = await list.json();
		const row = (body.data as Array<{ provider: string; default_model: string | null }>).find(
			(r) => r.provider === 'anthropic',
		);
		expect(row?.default_model).toBeNull();
	});

	it('PATCH /ai-providers/:configId sets and clears default_model', async () => {
		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const listBody = await list.json();
		const configId = (listBody.data as Array<{ id: string; provider: string }>).find(
			(r) => r.provider === 'anthropic',
		)?.id;
		expect(configId).toBeDefined();

		const patch = await app.request(`/api/ai-providers/${configId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_model: 'claude-opus-4-7' }),
		});
		expect(patch.status).toBe(200);
		expect((await patch.json()).data.default_model).toBe('claude-opus-4-7');

		const list2 = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const row2 = ((await list2.json()).data as Array<{ id: string; default_model: string }>).find(
			(r) => r.id === configId,
		);
		expect(row2?.default_model).toBe('claude-opus-4-7');

		const clear = await app.request(`/api/ai-providers/${configId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_model: null }),
		});
		expect(clear.status).toBe(200);
		expect((await clear.json()).data.default_model).toBeNull();
	});

	it('PATCH rejects non-superuser', async () => {
		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const configId = ((await list.json()).data as Array<{ id: string }>)[0].id;

		const res = await app.request(`/api/ai-providers/${configId}`, {
			method: 'PATCH',
			headers: { ...authHeader(nonSuperuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_model: 'anything' }),
		});
		expect(res.status).toBe(403);
	});

	it('PATCH returns 404 for unknown config', async () => {
		const res = await app.request('/api/ai-providers/00000000-0000-0000-0000-000000000000', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ default_model: 'foo' }),
		});
		expect(res.status).toBe(404);
	});
});

describe('AI providers models endpoint', () => {
	let configId: string;

	beforeAll(async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await db.query('DELETE FROM ai_provider_configs');
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'sk-openai-models-list',
				label: 'openai-models',
			}),
		});
		configId = (await res.json()).data.id;
	});

	it('returns normalized models for openai', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [
					{ id: 'gpt-5' },
					{ id: 'gpt-5-mini' },
					{ id: 'text-embedding-3-small' },
					{ id: 'whisper-1' },
				],
			}),
		}) as unknown as typeof fetch;

		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const ids = (body.data as Array<{ id: string }>).map((m) => m.id);
		expect(ids).toContain('gpt-5');
		expect(ids).toContain('gpt-5-mini');
		expect(ids).not.toContain('text-embedding-3-small');
		expect(ids).not.toContain('whisper-1');
	});

	it('rejects non-superusers', async () => {
		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(nonSuperuserToken),
		});
		expect(res.status).toBe(403);
	});

	it('returns 404 for unknown configId', async () => {
		const res = await app.request('/api/ai-providers/00000000-0000-0000-0000-000000000000/models', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(404);
	});

	it('surfaces provider errors', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
		}) as unknown as typeof fetch;

		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(401);
	});

	it('surfaces unreachable provider', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error('net')) as unknown as typeof fetch;

		const res = await app.request(`/api/ai-providers/${configId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(503);
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
