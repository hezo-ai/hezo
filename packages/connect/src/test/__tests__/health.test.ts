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
	it('returns platform list with all supported platforms', async () => {
		const res = await ctx.app.request('/platforms');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.platforms).toHaveLength(4);
		const ids = body.platforms.map((p: any) => p.id);
		expect(ids).toContain('github');
		expect(ids).toContain('anthropic');
		expect(ids).toContain('openai');
		expect(ids).toContain('google');
	});
});

describe('GET /signing-key', () => {
	it('returns the Ed25519 public key in PEM format', async () => {
		const res = await ctx.app.request('/signing-key');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.key).toContain('-----BEGIN PUBLIC KEY-----');
		expect(body.key).toContain('-----END PUBLIC KEY-----');
	});
});
