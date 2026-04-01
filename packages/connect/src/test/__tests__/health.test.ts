import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ConnectTestContext, createTestContext, destroyTestContext } from '../helpers/context';

let ctx: ConnectTestContext;

beforeAll(async () => {
	ctx = await createTestContext();
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('GET /health', () => {
	it('returns 200 with { ok: true }', async () => {
		const res = await ctx.app.request('/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns 200 via HTTP', async () => {
		const res = await fetch(`${ctx.baseUrl}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe('GET /platforms', () => {
	it('returns platform list with github', async () => {
		const res = await ctx.app.request('/platforms');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.platforms).toHaveLength(1);
		expect(body.platforms[0]).toEqual({
			id: 'github',
			name: 'GitHub',
			scopes: ['repo', 'workflow', 'read:org'],
		});
	});
});

describe('GET /signing-key', () => {
	it('returns the hex signing key', async () => {
		const res = await ctx.app.request('/signing-key');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.key).toBe('test-signing-key');
	});
});
