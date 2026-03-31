import { describe, expect, it } from 'vitest';
import { app } from '../../app';

describe('GET /health', () => {
	it('returns ok: true', async () => {
		const res = await app.request('/health');
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ ok: true });
	});
});
