import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type ServerTestContext } from '../helpers/context';

let ctx: ServerTestContext;

beforeAll(async () => {
	ctx = await createTestContext();
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('GET /health', () => {
	it('returns ok: true', async () => {
		const res = await ctx.app.request('/health');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it('returns ok: true via HTTP', async () => {
		const res = await fetch(`${ctx.baseUrl}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});
