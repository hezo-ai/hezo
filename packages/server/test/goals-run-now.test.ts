import type { PGlite } from '@electric-sql/pglite';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

// The manual "Run now" endpoint reuses the scheduled progress-update logic
// (`dispatchProgressUpdateNow` → `tryDispatchProgressUpdate`). These cover the deterministic
// decision paths — no due goals is a valid no-op (200), a due goal reaches run-gating — without
// launching a real agent (the launch body is the same code the heartbeat already exercises).
let db: PGlite;
let app: Hono<Env>;
let token: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Run Now Co', template_id: teamTemplateId });
	const teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Run Now Project' });
	projectSlug = (await projectRes.json()).data.slug;
});

afterAll(async () => {
	await safeClose(db);
});

function jsonHeaders() {
	return { ...authHeader(token), 'content-type': 'application/json' };
}

describe('POST /projects/:projectId/goals/run-now', () => {
	it('is a valid no-op (200, dispatched:false, reason:no_due_goals) when nothing is due', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/goals/run-now`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: '{}',
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.dispatched).toBe(false);
		expect(body.reason).toBe('no_due_goals');
	});

	it('resolves the Captain and reaches run-gating (409) when a goal is due but the container is down', async () => {
		// A freshly created goal has never been checked, so it is immediately due.
		const create = await app.request(`/api/projects/${projectSlug}/goals`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: JSON.stringify({
				title: 'Ship v1',
				measurement: 'v1 is live',
				check_frequency: 'daily',
			}),
		});
		expect(create.status).toBe(201);

		const res = await app.request(`/api/projects/${projectSlug}/goals/run-now`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: '{}',
		});
		// Past the "nothing due" check it hits run-gating — the test project has no running
		// container — so it is a 409 (not a 200 no-op and not a 404), proving the Captain and the
		// due goal were both resolved.
		expect(res.status).toBe(409);
		expect((await res.json()).error.message).toBeTruthy();
	});
});
