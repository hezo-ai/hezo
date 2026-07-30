import { HeartbeatRunStatus, WakeupSkipReason, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { getProjectRunLimit, isProjectAtRunLimitInDb } from '../src/services/run-concurrency';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';
import {
	clearDefaultMaxRunsPerProjectForTest,
	setDefaultMaxRunsPerProjectForTest,
	setProjectRunLimitForTest,
} from './helpers/capacity';

// The per-project run limit (rule 3 in services/run-concurrency.ts): how many of
// ONE project's agents may run at once inside its shared container. Distinct
// from the global active-container cap, which bounds host memory instead.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;
let siblingProjectId: string;

const json = { 'Content-Type': 'application/json' };

function createJobManager(overrides: Partial<JobManagerDeps> = {}): JobManager {
	return new JobManager({
		db,
		docker: createStubDocker(),
		masterKeyManager,
		serverPort: 3100,
		dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
		...overrides,
	});
}

/** A queued/running run in `projectId`, as the DB-side count sees it. */
async function insertRun(
	status: HeartbeatRunStatus = HeartbeatRunStatus.Running,
	onTaskId: string | null = taskId,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status) RETURNING id`,
		[teamId, agentId, onTaskId, status],
	);
	return r.rows[0].id;
}

async function insertQueuedWakeup(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, created_at)
		 VALUES ($1, $2, 'mention'::wakeup_source, 'queued'::wakeup_status, $3::jsonb,
		         now() - interval '30 seconds')
		 RETURNING id`,
		[agentId, teamId, JSON.stringify({ task_id: taskId })],
	);
	return r.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Run Limit Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Run Limit Project' });
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	// A second project under its own team — the limit is per project, so this one
	// must be unaffected by the first sitting at its ceiling.
	const siblingTeamRes = await createTestTeam(db, { name: 'Sibling Co', template_id: typeId });
	const siblingTeamId = (await siblingTeamRes.json()).data.id;
	const siblingRes = await createTestProject(db, siblingTeamId, { name: 'Sibling Project' });
	siblingProjectId = (await siblingRes.json()).data.id;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	agentId = ((await agentsRes.json()).data as Array<{ id: string }>)[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ project_id: projectId, title: 'Run Limit Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;

	await db.query(
		`UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1`,
		[projectId],
	);

	await waitForBackground();
	await db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		taskId,
	]);
});

beforeEach(async () => {
	await clearDefaultMaxRunsPerProjectForTest(db);
	await setProjectRunLimitForTest(db, projectId, null);
	await setProjectRunLimitForTest(db, siblingProjectId, null);
});

afterEach(async () => {
	await waitForBackground();
	await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
});

afterAll(async () => {
	await safeClose(db);
});

describe('getProjectRunLimit', () => {
	it('falls back to the shipped default of 3 when nothing is configured', async () => {
		expect(await getProjectRunLimit(db, projectId)).toBe(3);
	});

	it('uses the global default when the project sets no override', async () => {
		await setDefaultMaxRunsPerProjectForTest(db, 7);
		expect(await getProjectRunLimit(db, projectId)).toBe(7);
	});

	it("prefers the project's own override over the global default", async () => {
		await setDefaultMaxRunsPerProjectForTest(db, 7);
		await setProjectRunLimitForTest(db, projectId, 2);
		expect(await getProjectRunLimit(db, projectId)).toBe(2);
		// The sibling still inherits — an override is per project, not global.
		expect(await getProjectRunLimit(db, siblingProjectId)).toBe(7);
	});
});

describe('isProjectAtRunLimitInDb', () => {
	it('is false below the limit and true at it', async () => {
		await setProjectRunLimitForTest(db, projectId, 2);
		expect(await isProjectAtRunLimitInDb(db, projectId)).toBe(false);

		await insertRun();
		expect(await isProjectAtRunLimitInDb(db, projectId)).toBe(false);

		await insertRun();
		expect(await isProjectAtRunLimitInDb(db, projectId)).toBe(true);
	});

	it('counts queued runs, not just running ones', async () => {
		await setProjectRunLimitForTest(db, projectId, 1);
		await insertRun(HeartbeatRunStatus.Queued);
		expect(await isProjectAtRunLimitInDb(db, projectId)).toBe(true);
	});

	it('frees the slot when a run reaches a terminal status', async () => {
		await setProjectRunLimitForTest(db, projectId, 1);
		const runId = await insertRun();
		expect(await isProjectAtRunLimitInDb(db, projectId)).toBe(true);

		await db.query(
			`UPDATE heartbeat_runs SET status = 'succeeded'::heartbeat_run_status WHERE id = $1`,
			[runId],
		);
		expect(await isProjectAtRunLimitInDb(db, projectId)).toBe(false);
	});

	it('is unaffected by a sibling project sitting at its own ceiling', async () => {
		await setProjectRunLimitForTest(db, projectId, 1);
		await setProjectRunLimitForTest(db, siblingProjectId, 1);
		await insertRun();

		expect(await isProjectAtRunLimitInDb(db, projectId)).toBe(true);
		expect(await isProjectAtRunLimitInDb(db, siblingProjectId)).toBe(false);
	});
});

describe('JobManager.isProjectAtRunLimit — combining the DB count and the refcount', () => {
	it('does not double-count a run that is in BOTH the DB and the dispatch refcount', async () => {
		// The regression this guards: acquireProjectRun increments the in-memory
		// refcount *before* runAgent inserts the queued row, so for a window a
		// single run is visible to both signals. Summing them would read 2 here
		// and wrongly block the project's second run at a limit of 2.
		const manager = createJobManager() as unknown as {
			activeProjectRuns: Map<string, number>;
			isProjectAtRunLimit(projectId: string | null): Promise<boolean>;
			shutdown(): void;
		};
		await setProjectRunLimitForTest(db, projectId, 2);
		await insertRun(); // DB says 1
		manager.activeProjectRuns.set(projectId, 1); // and it is the same 1 run

		expect(await manager.isProjectAtRunLimit(projectId)).toBe(false);
		manager.shutdown();
	});

	it('blocks once the two signals genuinely describe the limit', async () => {
		const manager = createJobManager() as unknown as {
			activeProjectRuns: Map<string, number>;
			isProjectAtRunLimit(projectId: string | null): Promise<boolean>;
			shutdown(): void;
		};
		await setProjectRunLimitForTest(db, projectId, 2);
		await insertRun();
		await insertRun();
		manager.activeProjectRuns.set(projectId, 2);

		expect(await manager.isProjectAtRunLimit(projectId)).toBe(true);
		manager.shutdown();
	});

	it('counts a task-less progress-update run the DB query cannot see', async () => {
		// countActiveRunsInProject joins through tasks, so a run with task_id NULL
		// contributes 0 to the DB count. The refcount is what covers it.
		const manager = createJobManager() as unknown as {
			activeProjectRuns: Map<string, number>;
			isProjectAtRunLimit(projectId: string | null): Promise<boolean>;
			shutdown(): void;
		};
		await setProjectRunLimitForTest(db, projectId, 1);
		await insertRun(HeartbeatRunStatus.Running, null);

		// Proof of the blind spot: the DB-only gate misses it entirely.
		expect(await isProjectAtRunLimitInDb(db, projectId)).toBe(false);

		manager.activeProjectRuns.set(projectId, 1);
		expect(await manager.isProjectAtRunLimit(projectId)).toBe(true);
		manager.shutdown();
	});

	it('never gates a task-less caller with no project', async () => {
		const manager = createJobManager() as unknown as {
			isProjectAtRunLimit(projectId: string | null): Promise<boolean>;
			shutdown(): void;
		};
		expect(await manager.isProjectAtRunLimit(null)).toBe(false);
		manager.shutdown();
	});
});

describe('dispatchWakeupNow at the project run limit', () => {
	it('skips with project_at_run_limit and leaves the wakeup queued for retry', async () => {
		const manager = createJobManager();
		await setProjectRunLimitForTest(db, projectId, 1);
		// A run on a *different* task, so the task-busy gate does not fire first.
		const otherTask = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 9001, 'RL-9001', 'Other') RETURNING id`,
			[teamId, projectId],
		);
		await insertRun(HeartbeatRunStatus.Running, otherTask.rows[0].id);
		const wakeupId = await insertQueuedWakeup();

		const result = await manager.dispatchWakeupNow(wakeupId);
		expect(result).toEqual({ dispatched: false, reason: 'project_at_run_limit' });

		const ws = await db.query<{ status: string; last_skipped_reason: string | null }>(
			'SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeupId],
		);
		// Still queued, so the 5s dispatcher retries it once a slot frees.
		expect(ws.rows[0].status).toBe(WakeupStatus.Queued);
		expect(ws.rows[0].last_skipped_reason).toBe(WakeupSkipReason.ProjectAtRunLimit);

		manager.shutdown();
		await db.query('DELETE FROM tasks WHERE id = $1', [otherTask.rows[0].id]);
	});

	it('does not fire when the project is below its limit', async () => {
		const manager = createJobManager();
		await setProjectRunLimitForTest(db, projectId, 5);
		const wakeupId = await insertQueuedWakeup();

		const result = await manager.dispatchWakeupNow(wakeupId);
		// Whatever else happens downstream, it must not be the run-limit gate.
		if (!result.dispatched) expect(result.reason).not.toBe('project_at_run_limit');

		manager.shutdown();
	});
});
