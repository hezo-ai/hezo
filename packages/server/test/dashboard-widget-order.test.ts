import { DASHBOARD_WIDGET_IDS } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Widget Order Co' });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Order Test' });
	projectSlug = (await projectRes.json()).data.slug;
});

afterAll(async () => {
	await safeClose(db);
});

it('GET /projects/:projectId includes null dashboard_widget_order when none is saved', async () => {
	const res = await app.request(`/api/projects/${projectSlug}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()).data as { dashboard_widget_order: string[] | null };
	// Not yet set — null or absent is the initial state.
	expect(body.dashboard_widget_order == null).toBe(true);
});

it('PATCH /dashboard-widget-order saves and returns sanitised order', async () => {
	const order = ['team_snapshot', 'in_progress', 'goals', 'spend'];
	const res = await app.request(`/api/projects/${projectSlug}/dashboard-widget-order`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ order }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()).data as { order: string[] };
	expect(body.order).toEqual(order);
});

it('GET /projects/:projectId reflects the saved dashboard_widget_order', async () => {
	const order = ['spend', 'goals', 'team_snapshot', 'in_progress'];
	await app.request(`/api/projects/${projectSlug}/dashboard-widget-order`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ order }),
	});

	const res = await app.request(`/api/projects/${projectSlug}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()).data as { dashboard_widget_order: string[] };
	expect(body.dashboard_widget_order).toEqual(order);
});

it('PATCH /dashboard-widget-order rejects unknown widget id', async () => {
	const res = await app.request(`/api/projects/${projectSlug}/dashboard-widget-order`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ order: ['goals', 'unknown_widget'] }),
	});
	expect(res.status).toBe(400);
});

it('PATCH /dashboard-widget-order rejects duplicate widget ids', async () => {
	const res = await app.request(`/api/projects/${projectSlug}/dashboard-widget-order`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ order: ['goals', 'goals', 'spend'] }),
	});
	expect(res.status).toBe(400);
});

it('PATCH /dashboard-widget-order accepts a partial order and fills in missing ids', async () => {
	const partial = ['spend', 'team_snapshot'];
	const res = await app.request(`/api/projects/${projectSlug}/dashboard-widget-order`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ order: partial }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()).data as { order: string[] };
	// Must start with the partial, then have all remaining ids appended.
	expect(body.order.slice(0, 2)).toEqual(partial);
	expect(body.order).toHaveLength(DASHBOARD_WIDGET_IDS.length);
	const orderSet = new Set(body.order);
	for (const id of DASHBOARD_WIDGET_IDS) {
		expect(orderSet.has(id)).toBe(true);
	}
});
