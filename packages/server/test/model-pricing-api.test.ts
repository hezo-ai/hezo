import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { signAdminJwt } from '../src/middleware/auth';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';
import { pptModel, stubPricePerTokenFetch } from './helpers/pricing';

let app: Hono<Env>;
let db: Db;
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
	it('lists the migration-baked catalog rows', async () => {
		const res = await app.request('/api/model-pricing', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const rows = (await res.json()).data as Array<{ model_id: string; source: string }>;
		// The 014 migration bakes the pricepertoken catalog in, so the list is
		// populated before any refresh has run.
		expect(rows.length).toBeGreaterThan(400);
		expect(rows.every((r) => r.source === 'pricepertoken' || r.source === 'manual')).toBe(true);
		expect(rows.some((r) => r.model_id === 'claude-opus-4.8' && r.source === 'pricepertoken')).toBe(
			true,
		);
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

	it('refreshes from the (stubbed) pricepertoken MCP server', async () => {
		const original = globalThis.fetch;
		const { fetchImpl } = stubPricePerTokenFetch([
			pptModel('acme-feed-model-a', 'Acme', 10, 20),
			pptModel('acme-feed-model-b', 'Acme', 30, 40),
		]);
		globalThis.fetch = fetchImpl as unknown as typeof fetch;
		try {
			const res = await app.request('/api/model-pricing/refresh', {
				method: 'POST',
				headers: authHeader(token),
			});
			expect(res.status).toBe(200);
			expect((await res.json()).data.refreshed).toBe(2);
		} finally {
			globalThis.fetch = original;
		}

		const list = await app.request('/api/model-pricing', { headers: authHeader(token) });
		const rows = (await list.json()).data as Array<{ model_id: string; source: string }>;
		expect(rows.some((r) => r.model_id === 'feed-model-a' && r.source === 'pricepertoken')).toBe(
			true,
		);
	});

	it('returns 503 when the upstream catalog is unavailable', async () => {
		const original = globalThis.fetch;
		const { fetchImpl } = stubPricePerTokenFetch([], { status: 502 });
		globalThis.fetch = fetchImpl as unknown as typeof fetch;
		try {
			const res = await app.request('/api/model-pricing/refresh', {
				method: 'POST',
				headers: authHeader(token),
			});
			expect(res.status).toBe(503);
		} finally {
			globalThis.fetch = original;
		}
	});
});
