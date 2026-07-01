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

	it('queues the run (200, queued) when a goal is due but the container is down', async () => {
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
		// container (a transient conflict) — so instead of a 409 the run is queued to fire once
		// the Captain is free. Proves the Captain and the due goal were both resolved.
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.queued).toBe(true);
		expect(body.wakeup_id).toBeTruthy();

		// A single queued progress-update wakeup was created for the Captain.
		const queued = await db.query<{ payload: Record<string, unknown> }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE id = $1 AND status = 'queued'::wakeup_status`,
			[body.wakeup_id],
		);
		expect(queued.rows.length).toBe(1);
		expect(queued.rows[0].payload.trigger).toBe('progress_update_now');
		expect(queued.rows[0].payload.project_id).toBeTruthy();

		// It surfaces via the project-scoped queued-run endpoint.
		const list = await app.request(`/api/projects/${projectSlug}/goals/queued-run`, {
			headers: authHeader(token),
		});
		expect(list.status).toBe(200);
		expect((await list.json()).data.queued.id).toBe(body.wakeup_id);

		// "Run now" again is idempotent — same wakeup, no second row.
		const again = await app.request(`/api/projects/${projectSlug}/goals/run-now`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: '{}',
		});
		expect((await again.json()).data.wakeup_id).toBe(body.wakeup_id);
		const count = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM agent_wakeup_requests
			 WHERE status = 'queued'::wakeup_status AND payload->>'trigger' = 'progress_update_now'`,
		);
		expect(count.rows[0].c).toBe(1);

		// Cancelling removes it from the queue.
		const cancel = await app.request(
			`/api/projects/${projectSlug}/goals/queued-run/${body.wakeup_id}/cancel`,
			{ method: 'POST', headers: jsonHeaders(), body: '{}' },
		);
		expect(cancel.status).toBe(200);
		expect((await cancel.json()).data.cancelled).toBe(true);

		const afterCancel = await app.request(`/api/projects/${projectSlug}/goals/queued-run`, {
			headers: authHeader(token),
		});
		expect((await afterCancel.json()).data.queued).toBe(null);

		// Cancelling an already-cancelled run is a 409.
		const recancel = await app.request(
			`/api/projects/${projectSlug}/goals/queued-run/${body.wakeup_id}/cancel`,
			{ method: 'POST', headers: jsonHeaders(), body: '{}' },
		);
		expect(recancel.status).toBe(409);
	});
});
