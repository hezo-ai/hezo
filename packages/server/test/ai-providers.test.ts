import { AiProvider } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { getPinnedModel } from '../src/services/model-pins';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let nonSuperuserToken: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const nonAdmin = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Regular Admin', false) RETURNING id",
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
	it('allows non-superuser the admin to read the status', async () => {
		const res = await app.request('/api/ai-providers/status', {
			headers: authHeader(nonSuperuserToken),
		});
		expect(res.status).toBe(200);
	});

	it('rejects non-superusers from creating configs', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(nonSuperuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'openai', api_key: 'sk-openai-test' }),
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
});

describe('AI providers subscription auth', () => {
	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
	});

	const validCodexBlob = JSON.stringify({
		tokens: {
			id_token: 'header.payload.sig',
			access_token: 'header.payload.sig',
			refresh_token: 'rt-test-token-1',
			account_id: 'acct-123',
		},
	});

	it('rejects subscription auth for deepseek (no subscription support)', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'deepseek',
				api_key: validCodexBlob,
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('UNSUPPORTED_AUTH_METHOD');
	});

	it('rejects an API key pasted as an anthropic setup-token', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-api03-not-a-setup-token',
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_SUBSCRIPTION_BLOB');
	});

	it('rejects malformed auth.json for openai', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'not-json',
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_SUBSCRIPTION_BLOB');
	});

	it('rejects auth.json missing tokens.refresh_token for openai', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: JSON.stringify({ tokens: { access_token: 'just-access' } }),
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_SUBSCRIPTION_BLOB');
	});

	it('rejects subscription auth for google - it is API-key only', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'google',
				api_key: JSON.stringify({ refresh_token: 'rt' }),
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('UNSUPPORTED_AUTH_METHOD');
	});

	it('stores a valid codex auth.json blob for openai', async () => {
		await db.query('DELETE FROM ai_provider_configs');
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: validCodexBlob,
				auth_method: 'subscription',
				label: 'chatgpt-pro',
			}),
		});
		expect(res.status).toBe(201);

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const body = await list.json();
		const stored = (body.data as Array<{ provider: string; auth_method: string }>).find(
			(r) => r.provider === 'openai',
		);
		expect(stored?.auth_method).toBe('subscription');
	});

	it('skips api-key prefix validation when auth_method=subscription', async () => {
		await db.query('DELETE FROM ai_provider_configs');
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: validCodexBlob,
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(201);
	});

	it('stores an anthropic setup-token as a subscription credential', async () => {
		await db.query('DELETE FROM ai_provider_configs');
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-oat01-live-token',
				auth_method: 'subscription',
				label: 'claude-max',
			}),
		});
		expect(res.status).toBe(201);

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const body = await list.json();
		const stored = (body.data as Array<{ provider: string; auth_method: string }>).find(
			(r) => r.provider === 'anthropic',
		);
		expect(stored?.auth_method).toBe('subscription');
	});

	it('rejects subscription auth for kimi (Claude Code/Moonshot is api-key only)', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'kimi',
				api_key: JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		// Kimi no longer advertises subscription support, so the route rejects the
		// auth method outright before any blob validation.
		expect(body.error.code).toBe('UNSUPPORTED_AUTH_METHOD');
	});

	it('stores an api-key credential for kimi', async () => {
		await db.query('DELETE FROM ai_provider_configs');
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'kimi',
				api_key: 'sk-kimi-key',
				auth_method: 'api_key',
				label: 'kimi-pro',
			}),
		});
		expect(res.status).toBe(201);

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const body = await list.json();
		const stored = (body.data as Array<{ provider: string; auth_method: string }>).find(
			(r) => r.provider === 'kimi',
		);
		expect(stored?.auth_method).toBe('api_key');
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

	it('starts a new config on the provider’s pinned model', async () => {
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
		// A new credential is offered the pinned default rather than left on none,
		// so an operator who adds a key and walks away still has a working model.
		// Against the pin, not a literal, since the pin moves with the catalog.
		expect(row?.default_model).toBe(await getPinnedModel(db, AiProvider.Anthropic));
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

describe('AI providers rename', () => {
	let firstId: string;
	let secondId: string;

	beforeAll(async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		await db.query('DELETE FROM ai_provider_configs');

		const first = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-rename-a',
				label: 'anthropic-a',
			}),
		});
		firstId = (await first.json()).data.id;

		const second = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-rename-b',
				label: 'anthropic-b',
			}),
		});
		secondId = (await second.json()).data.id;
	});

	it('PATCH renames a config (trimmed) and the list reflects it', async () => {
		const res = await app.request(`/api/ai-providers/${firstId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ label: '  anthropic-renamed  ' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.updated).toBe(true);
		expect(body.data.label).toBe('anthropic-renamed');

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const row = ((await list.json()).data as Array<{ id: string; label: string }>).find(
			(r) => r.id === firstId,
		);
		expect(row?.label).toBe('anthropic-renamed');
	});

	it('rejects an empty or whitespace-only label', async () => {
		for (const label of ['', '   ']) {
			const res = await app.request(`/api/ai-providers/${firstId}`, {
				method: 'PATCH',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ label }),
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error.code).toBe('INVALID_REQUEST');
		}
	});

	it('rejects a label already used by another config of the same provider', async () => {
		const res = await app.request(`/api/ai-providers/${firstId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ label: 'anthropic-b' }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('DUPLICATE');
	});

	it('allows the same label across different providers', async () => {
		const created = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'sk-openai-rename',
				label: 'openai-rename-me',
			}),
		});
		const openaiId = (await created.json()).data.id;

		const res = await app.request(`/api/ai-providers/${openaiId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ label: 'anthropic-b' }),
		});
		expect(res.status).toBe(200);
	});

	it('renames and sets default_model in one PATCH', async () => {
		const res = await app.request(`/api/ai-providers/${secondId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ label: 'anthropic-b2', default_model: 'claude-opus-4-7' }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.label).toBe('anthropic-b2');
		expect(body.data.default_model).toBe('claude-opus-4-7');

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const row = (
			(await list.json()).data as Array<{ id: string; label: string; default_model: string }>
		).find((r) => r.id === secondId);
		expect(row?.label).toBe('anthropic-b2');
		expect(row?.default_model).toBe('claude-opus-4-7');
	});

	it('a label-only rename preserves default_model', async () => {
		const res = await app.request(`/api/ai-providers/${secondId}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ label: 'anthropic-b3' }),
		});
		expect(res.status).toBe(200);

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const row = (
			(await list.json()).data as Array<{ id: string; label: string; default_model: string }>
		).find((r) => r.id === secondId);
		expect(row?.label).toBe('anthropic-b3');
		expect(row?.default_model).toBe('claude-opus-4-7');
	});

	it('returns 404 when renaming an unknown config', async () => {
		const res = await app.request('/api/ai-providers/00000000-0000-0000-0000-000000000000', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ label: 'ghost' }),
		});
		expect(res.status).toBe(404);
	});

	it('rejects non-superusers', async () => {
		const res = await app.request(`/api/ai-providers/${firstId}`, {
			method: 'PATCH',
			headers: { ...authHeader(nonSuperuserToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ label: 'sneaky' }),
		});
		expect(res.status).toBe(403);
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

	it('short-circuits subscription auth without a live provider call', async () => {
		const codexBlob = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig',
				access_token: 'header.payload.sig',
				refresh_token: 'rt-test-token-1',
				account_id: 'acct-123',
			},
		});
		const created = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: codexBlob,
				auth_method: 'subscription',
				label: 'openai-subscription-models',
			}),
		});
		expect(created.status).toBe(201);
		const subConfigId = (await created.json()).data.id;

		// Even if the provider were reachable, subscription auth must not attempt a
		// catalog call — a throwing fetch would surface as 503 if we didn't skip it.
		const fetchSpy = vi
			.fn()
			.mockRejectedValue(new Error('should not be called')) as unknown as typeof fetch;
		globalThis.fetch = fetchSpy;

		const res = await app.request(`/api/ai-providers/${subConfigId}/models`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('SUBSCRIPTION_UNSUPPORTED');
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('AI providers single global default invariant', () => {
	async function addProvider(provider: string, apiKey: string, label: string): Promise<string> {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider, api_key: apiKey, label }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).data.id;
	}

	async function listConfigs(): Promise<Array<{ id: string; is_default: boolean }>> {
		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		return (await list.json()).data;
	}

	it('auto-defaults only the first config added to the instance', async () => {
		await db.query('DELETE FROM ai_provider_configs');

		const firstId = await addProvider('anthropic', 'sk-ant-first', 'anthropic-a');
		// A second config for a DIFFERENT provider does not become a second default.
		const secondId = await addProvider('deepseek', 'sk-deepseek-second', 'deepseek-a');

		const configs = await listConfigs();
		const defaults = configs.filter((c) => c.is_default);
		expect(defaults.length).toBe(1);
		expect(defaults[0].id).toBe(firstId);
		expect(configs.find((c) => c.id === secondId)?.is_default).toBe(false);
	});

	it('enforces exactly one default instance-wide after promoting across providers', async () => {
		await db.query('DELETE FROM ai_provider_configs');

		const anthropicId = await addProvider('anthropic', 'sk-ant-a', 'anthropic-a');
		const googleId = await addProvider('google', 'gm-b', 'google-b');

		const promote = await app.request(`/api/ai-providers/${googleId}/default`, {
			method: 'PATCH',
			headers: authHeader(token),
		});
		expect(promote.status).toBe(200);

		const configs = await listConfigs();
		const defaults = configs.filter((c) => c.is_default);
		expect(defaults.length).toBe(1);
		expect(defaults[0].id).toBe(googleId);
		expect(configs.find((c) => c.id === anthropicId)?.is_default).toBe(false);
	});
});

describe('AI providers auth_method coexistence', () => {
	it('allows a subscription auth.json alongside an existing API key for openai', async () => {
		await db.query('DELETE FROM ai_provider_configs');

		const apiRes = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: 'sk-coexist-api',
				label: 'openai-coexist-api',
				auth_method: 'api_key',
			}),
		});
		expect(apiRes.status).toBe(201);

		const subRes = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'openai',
				api_key: JSON.stringify({ tokens: { refresh_token: 'rt-coexist' } }),
				label: 'openai-coexist-subscription',
				auth_method: 'subscription',
			}),
		});
		expect(subRes.status).toBe(201);

		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const rows = (await list.json()).data as Array<{ provider: string; auth_method: string }>;
		const openai = rows.filter((r) => r.provider === 'openai');
		expect(openai.length).toBe(2);
		expect(openai.some((r) => r.auth_method === 'api_key')).toBe(true);
		expect(openai.some((r) => r.auth_method === 'subscription')).toBe(true);
	});
});

describe('AI providers DeepSeek', () => {
	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
	});

	it('accepts a DeepSeek API key (no key prefix constraint)', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'deepseek',
				api_key: 'sk-deepseek-no-prefix-required',
				label: 'deepseek-primary',
			}),
		});
		expect(res.status).toBe(201);
		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const rows = (await list.json()).data as Array<{ provider: string }>;
		expect(rows.some((r) => r.provider === 'deepseek')).toBe(true);
	});

	it('rejects subscription auth for deepseek (Claude Code subscription is not a DeepSeek concept)', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'deepseek',
				api_key: JSON.stringify({ tokens: { refresh_token: 'rt' } }),
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('UNSUPPORTED_AUTH_METHOD');
	});

	it('reports deepseek under the configured providers status', async () => {
		const res = await app.request('/api/ai-providers/status', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.providers).toContain('deepseek');
	});
});

describe('AI providers z.ai', () => {
	beforeAll(async () => {
		await db.query('DELETE FROM ai_provider_configs');
	});

	it('accepts a z.ai API key (no key prefix constraint)', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'z_ai',
				api_key: 'zai-no-prefix-required',
				label: 'zai-primary',
			}),
		});
		expect(res.status).toBe(201);
		const list = await app.request('/api/ai-providers', { headers: authHeader(token) });
		const rows = (await list.json()).data as Array<{ provider: string }>;
		expect(rows.some((r) => r.provider === 'z_ai')).toBe(true);
	});

	it('rejects subscription auth for z.ai (API key only)', async () => {
		const res = await app.request('/api/ai-providers', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'z_ai',
				api_key: JSON.stringify({ tokens: { refresh_token: 'rt' } }),
				auth_method: 'subscription',
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('UNSUPPORTED_AUTH_METHOD');
	});

	it('reports z_ai under the configured providers status', async () => {
		const res = await app.request('/api/ai-providers/status', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.providers).toContain('z_ai');
	});
});
