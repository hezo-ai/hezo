import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let companyId: string;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'AI Provider Co', issue_prefix: 'AIP' }),
	});
	companyId = (await companyRes.json()).data.id;
});

beforeEach(() => {
	// Mock fetch to simulate provider validation succeeding by default
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
		const res = await app.request(`/api/companies/${companyId}/ai-providers/status`, {
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
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				provider: 'anthropic',
				api_key: 'sk-ant-test-key-12345',
				label: 'Test Anthropic Key',
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.data.id).toBeDefined();
		configId = body.data.id;
	});

	it('lists configured providers without exposing key values', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].provider).toBe('anthropic');
		expect(body.data[0].label).toBe('Test Anthropic Key');
		expect(body.data[0].is_default).toBe(true);
		expect(body.data[0].auth_method).toBe('api_key');
		// Must never expose the actual key
		expect(body.data[0]).not.toHaveProperty('api_key');
		expect(body.data[0]).not.toHaveProperty('encrypted_value');
	});

	it('returns configured: true after adding a provider', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers/status`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.configured).toBe(true);
		expect(body.data.providers).toContain('anthropic');
	});

	it('rejects invalid provider name', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'invalid', api_key: 'test' }),
		});
		expect(res.status).toBe(400);
	});

	it('rejects empty API key', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'openai', api_key: '' }),
		});
		expect(res.status).toBe(400);
	});

	it('adds a second provider (openai)', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
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
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.length).toBe(2);
	});

	it('deletes a provider config', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers/${configId}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.deleted).toBe(true);

		// Verify it's gone
		const listRes = await app.request(`/api/companies/${companyId}/ai-providers`, {
			headers: authHeader(token),
		});
		const body = await listRes.json();
		expect(body.data.length).toBe(1);
		expect(body.data[0].provider).toBe('openai');
	});

	it('returns 404 for non-existent config deletion', async () => {
		const res = await app.request(
			`/api/companies/${companyId}/ai-providers/00000000-0000-0000-0000-000000000000`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(res.status).toBe(404);
	});
});

describe('AI providers authorization', () => {
	it('rejects unauthenticated requests', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers`);
		expect(res.status).toBe(401);
	});

	it('rejects access to other company providers', async () => {
		// Create a second company
		const companyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Other Co', issue_prefix: 'OTH' }),
		});
		const otherCompanyId = (await companyRes.json()).data.id;

		// Add a provider to the other company
		await app.request(`/api/companies/${otherCompanyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'moonshot', api_key: 'sk-moonshot-test-key' }),
		});

		// The first company should not see the other company's providers
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			headers: authHeader(token),
		});
		const body = await res.json();
		const providers = body.data.map((p: any) => p.provider);
		expect(providers).not.toContain('moonshot');
	});
});

describe('AI providers key format validation', () => {
	it('rejects anthropic keys without sk-ant- prefix', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'anthropic', api_key: 'invalid-key-format' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_KEY_FORMAT');
	});

	it('accepts moonshot keys without prefix check', async () => {
		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'moonshot', api_key: 'any-key-format-is-fine' }),
		});
		// Moonshot has no keyPrefix, so any format should be accepted
		expect(res.status).toBe(201);
	});
});

describe('AI providers key validation against provider API', () => {
	it('rejects a key that the provider says is invalid', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;

		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'anthropic', api_key: 'sk-ant-invalid-key' }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe('INVALID_KEY');
	});

	it('returns 503 when the provider is unreachable', async () => {
		globalThis.fetch = vi
			.fn()
			.mockRejectedValue(new Error('Network error')) as unknown as unknown as typeof fetch;

		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'openai', api_key: 'sk-unreachable-key' }),
		});
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error.code).toBe('VALIDATION_FAILED');
	});

	it('stores the key when provider confirms it is valid', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;

		const res = await app.request(`/api/companies/${companyId}/ai-providers`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: 'google', api_key: 'AIza-valid-test-key' }),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).data.id).toBeDefined();
	});
});
