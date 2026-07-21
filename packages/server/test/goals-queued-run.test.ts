import { WakeupSkipReason, WakeupSource, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';

// The queued manual progress-update run ("Run now" while the Captain is busy). Covers the queue
// dedup that must NOT cross-coalesce with the Captain's scheduled task-less heartbeat wakeup, the
// project-scoped list/cancel routes, and the activateAgent guard that keeps a queued progress
// wakeup from falling through to ordinary task selection.
let db: Db;
let app: Hono<Env>;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let captainId: string;

const json = { 'content-type': 'application/json' };

function createJobManager(): JobManager {
	return new JobManager({
		db,
		docker: createStubDocker(),
		masterKeyManager,
		serverPort: 3100,
		dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Queued Run Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Queued Run Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
		[teamId],
	);
	captainId = captain.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

function jsonHeaders() {
	return { ...authHeader(token), ...json };
}

async function createDueGoal(title: string): Promise<void> {
	const res = await app.request(`/api/projects/${projectSlug}/goals`, {
		method: 'POST',
		headers: jsonHeaders(),
		body: JSON.stringify({ title, measurement: 'm', check_frequency: 'daily' }),
	});
	expect(res.status).toBe(201);
}

async function insertProgressWakeup(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, idempotency_key)
		 VALUES ($1, $2, $3::wakeup_source, 'queued'::wakeup_status, $4::jsonb, $5)
		 RETURNING id`,
		[
			captainId,
			teamId,
			WakeupSource.OnDemand,
			JSON.stringify({ trigger: 'progress_update_now', project_id: projectId }),
			`progress_update_now:${captainId}`,
		],
	);
	return r.rows[0].id;
}

async function wakeupRow(id: string) {
	const r = await db.query<{ status: string; last_skipped_reason: string | null }>(
		`SELECT status::text AS status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1`,
		[id],
	);
	return r.rows[0];
}

describe('queued manual progress-update run', () => {
	it('does not cross-coalesce with the Captain scheduled heartbeat wakeup', async () => {
		await createDueGoal('Coalesce guard goal');

		// A pre-existing task-less scheduled heartbeat wakeup for the same Captain.
		const heartbeat = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, $3::wakeup_source, 'queued'::wakeup_status, '{}'::jsonb)
			 RETURNING id`,
			[captainId, teamId, WakeupSource.Heartbeat],
		);
		const heartbeatId = heartbeat.rows[0].id;

		const res = await app.request(`/api/projects/${projectSlug}/goals/run-now`, {
			method: 'POST',
			headers: jsonHeaders(),
			body: '{}',
		});
		expect(res.status).toBe(200);
		const body = (await res.json()).data;
		expect(body.queued).toBe(true);
		expect(body.wakeup_id).not.toBe(heartbeatId);

		// The heartbeat wakeup is untouched (still no trigger) — it was NOT merged with the
		// progress wakeup, and a distinct progress wakeup row exists.
		const hb = await db.query<{ payload: Record<string, unknown> }>(
			`SELECT payload FROM agent_wakeup_requests WHERE id = $1`,
			[heartbeatId],
		);
		expect(hb.rows[0].payload.trigger).toBeUndefined();

		const progress = await db.query<{ payload: Record<string, unknown> }>(
			`SELECT payload FROM agent_wakeup_requests WHERE id = $1`,
			[body.wakeup_id],
		);
		expect(progress.rows[0].payload.trigger).toBe('progress_update_now');

		// The list surfaces only the manual progress wakeup, never the heartbeat.
		const list = await app.request(`/api/projects/${projectSlug}/goals/queued-run`, {
			headers: authHeader(token),
		});
		expect((await list.json()).data.queued.id).toBe(body.wakeup_id);

		// Cleanup so later tests start clean.
		await db.query(`DELETE FROM agent_wakeup_requests WHERE id = ANY($1)`, [
			[heartbeatId, body.wakeup_id],
		]);
	});

	it('cancel returns 404 for an unknown wakeup id', async () => {
		const res = await app.request(
			`/api/projects/${projectSlug}/goals/queued-run/00000000-0000-0000-0000-000000000000/cancel`,
			{ method: 'POST', headers: jsonHeaders(), body: '{}' },
		);
		expect(res.status).toBe(404);
	});

	it('re-queues (not falls through to task work) when the container is down at dispatch', async () => {
		// Due goal + no running container ⇒ tryDispatchProgressUpdate returns container_down.
		const wakeupId = await insertProgressWakeup();
		const manager = createJobManager();

		// Drive activateAgent through the public run-now dispatch (task-less path).
		await manager.dispatchWakeupNow(wakeupId);

		// The guard re-queued the wakeup with a container_down skip reason instead of letting
		// the Captain fall through to picking up a task.
		const ws = await wakeupRow(wakeupId);
		expect(ws.status).toBe(WakeupStatus.Queued);
		expect(ws.last_skipped_reason).toBe(WakeupSkipReason.ContainerDown);

		// No progress-update run was started (still no container).
		const runs = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM heartbeat_runs WHERE member_id = $1`,
			[captainId],
		);
		expect(runs.rows[0].c).toBe(0);

		manager.shutdown();
		await db.query(`DELETE FROM agent_wakeup_requests WHERE id = $1`, [wakeupId]);
	});

	it('completes the queued run as a no-op when no goals are due at dispatch', async () => {
		// Archive the due goals so nothing is due, then dispatch the queued progress wakeup.
		await db.query(`UPDATE goals SET archived_at = now() WHERE project_id = $1`, [projectId]);
		const wakeupId = await insertProgressWakeup();
		const manager = createJobManager();

		await manager.dispatchWakeupNow(wakeupId);

		// Nothing due ⇒ the queued run is a no-op: completed, not left queued, and no task run.
		const ws = await wakeupRow(wakeupId);
		expect(ws.status).toBe(WakeupStatus.Completed);
		const runs = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM heartbeat_runs WHERE member_id = $1`,
			[captainId],
		);
		expect(runs.rows[0].c).toBe(0);

		manager.shutdown();
	});
});
