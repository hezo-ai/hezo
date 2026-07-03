import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { CURATED_RATES } from '../src/services/pricing';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let nonSuperuserToken: string;

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

afterAll(async () => {
	await safeClose(db);
});

function post(body: unknown, authToken = token) {
	return app.request('/api/model-pricing', {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

describe('model pricing API', () => {
	it('lists pricing rows (initially empty)', async () => {
		const res = await app.request('/api/model-pricing', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual([]);
	});

	it('creates a manual override and surfaces it in the list', async () => {
		const res = await post({
			model_id: 'custom-model-1',
			input_per_token: 0.000002,
			output_per_token: 0.000008,
			cache_read_per_token: 0.0000002,
		});
		expect(res.status).toBe(201);
		const row = (await res.json()).data;
		expect(row.model_id).toBe('custom-model-1');
		expect(row.source).toBe('manual');

		const list = await app.request('/api/model-pricing', { headers: authHeader(token) });
		const rows = (await list.json()).data as Array<{ model_id: string }>;
		expect(rows.some((r) => r.model_id === 'custom-model-1')).toBe(true);
	});

	it('upserts an existing manual row instead of duplicating it', async () => {
		await post({ model_id: 'custom-model-1', input_per_token: 0.00001, output_per_token: 0.00001 });
		const list = await app.request('/api/model-pricing', { headers: authHeader(token) });
		const rows = (await list.json()).data as Array<{ model_id: string; input_per_token: number }>;
		const matches = rows.filter((r) => r.model_id === 'custom-model-1');
		expect(matches).toHaveLength(1);
		expect(matches[0].input_per_token).toBe(0.00001);
	});

	it('rejects invalid bodies with 400', async () => {
		expect((await post({ input_per_token: 1, output_per_token: 1 })).status).toBe(400);
		expect((await post({ model_id: 'x', input_per_token: -1, output_per_token: 1 })).status).toBe(
			400,
		);
		expect(
			(await post({ model_id: 'x', input_per_token: 1, output_per_token: 'nope' })).status,
		).toBe(400);
	});

	it('forbids non-superusers from writing', async () => {
		const res = await post(
			{ model_id: 'sneaky', input_per_token: 1, output_per_token: 1 },
			nonSuperuserToken,
		);
		expect(res.status).toBe(403);
	});

	it('deletes a manual override', async () => {
		const created = await post({
			model_id: 'to-delete',
			input_per_token: 0.00001,
			output_per_token: 0.00001,
		});
		const id = (await created.json()).data.id as string;
		const del = await app.request(`/api/model-pricing/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(del.status).toBe(200);
		const again = await app.request(`/api/model-pricing/${id}`, {
			method: 'DELETE',
			headers: authHeader(token),
		});
		expect(again.status).toBe(404);
	});

	it('refreshes from the (stubbed) feed', async () => {
		const original = globalThis.fetch;
		globalThis.fetch = (async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				'feed-model-a': { input_cost_per_token: 0.00001, output_cost_per_token: 0.00002 },
				'feed-model-b': { input_cost_per_token: 0.00003, output_cost_per_token: 0.00004 },
			}),
		})) as unknown as typeof fetch;
		try {
			const res = await app.request('/api/model-pricing/refresh', {
				method: 'POST',
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			// The two stub feed models plus the curated built-in overrides that merge
			// into every refresh.
			expect((await res.json()).data.refreshed).toBe(2 + CURATED_RATES.length);
		} finally {
			globalThis.fetch = original;
		}

		const list = await app.request('/api/model-pricing', { headers: authHeader(token) });
		const rows = (await list.json()).data as Array<{ model_id: string; source: string }>;
		expect(rows.some((r) => r.model_id === 'feed-model-a' && r.source === 'litellm')).toBe(true);
	});
});
