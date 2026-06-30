import type { PGlite } from '@electric-sql/pglite';
import { HeartbeatRunStatus, TaskStatus, WakeupSource, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { ContainerLogStreamer } from '../src/services/container-logs';
import type { DockerClient } from '../src/services/docker';
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

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;
let otherAgentId: string;

function createJobManager(overrides: Partial<JobManagerDeps> = {}): JobManager {
	return new JobManager({
		db,
		docker: createStubDocker() as unknown as DockerClient,
		masterKeyManager,
		serverPort: 3100,
		dataDir: '/tmp/test-data',
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
		...overrides,
	});
}

interface RunResultShape {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	heartbeatRunId: string;
}

function callOnAgentComplete(manager: JobManager, result: RunResultShape): Promise<void> {
	return (
		manager as unknown as {
			onAgentComplete(
				m: string,
				s: string,
				t: string,
				ti: string,
				team: string,
				w: string | undefined,
				p: Record<string, unknown> | undefined,
				r: RunResultShape,
			): Promise<void>;
		}
	).onAgentComplete(agentId, 'engineer', taskId, 'CONT-1', teamId, undefined, undefined, result);
}

async function seedRun(opts: {
	producedOutput: boolean;
	reportedNoWork: boolean;
}): Promise<string> {
	const run = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, produced_output, reported_no_work)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, now(), $5, $6)
		 RETURNING id`,
		[
			agentId,
			teamId,
			taskId,
			HeartbeatRunStatus.Succeeded,
			opts.producedOutput,
			opts.reportedNoWork,
		],
	);
	return run.rows[0].id;
}

async function continuationWakeups(): Promise<{ status: string; source: string }[]> {
	const res = await db.query<{ status: string; source: string }>(
		`SELECT status, source FROM agent_wakeup_requests
		 WHERE member_id = $1
		   AND payload->>'task_id' = $2
		   AND payload->>'reason' = 'deferred_continuation'`,
		[agentId, taskId],
	);
	return res.rows;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Continuation Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Continuation Project',
		description: 'Test project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data;
	const engineer = agents.find((a: { slug: string }) => a.slug === 'engineer') ?? agents[0];
	const other = agents.find((a: { id: string }) => a.id !== engineer.id) ?? agents[1];
	agentId = engineer.id;
	otherAgentId = other.id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Continuation Task',
			description: 'Task for deferred-continuation testing',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

beforeEach(async () => {
	// Drain any in-flight background wakeup creation (e.g. the assignment wakeup
	// from task creation) before clearing, so it can't land after the delete and
	// let a fresh continuation wakeup coalesce onto it.
	await waitForBackground();
	// Reset to the eligible baseline: task in_progress, assigned to the engineer,
	// no leftover wakeups/runs from a prior case. Clear every wakeup touching this
	// agent or task so a fresh continuation wakeup can't coalesce onto a stale one.
	await db.query(
		`DELETE FROM agent_wakeup_requests
		 WHERE member_id = $1 OR member_id = $2 OR payload->>'task_id' = $3`,
		[agentId, otherAgentId, taskId],
	);
	await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1', [taskId]);
	await db.query('UPDATE tasks SET status = $1::task_status, assignee_id = $2 WHERE id = $3', [
		TaskStatus.InProgress,
		agentId,
		taskId,
	]);
});

afterAll(async () => {
	await waitForBackground();
	await safeClose(db);
});

describe('deferred-continuation wakeup', () => {
	it('enqueues a near-term Timer wakeup when a productive run leaves its task in_progress and self-assigned', async () => {
		const manager = createJobManager();
		const runId = await seedRun({ producedOutput: true, reportedNoWork: false });

		await callOnAgentComplete(manager, {
			success: true,
			exitCode: 0,
			stdout: '',
			stderr: '',
			heartbeatRunId: runId,
		});

		const wakeups = await continuationWakeups();
		expect(wakeups.length).toBe(1);
		expect(wakeups[0].status).toBe(WakeupStatus.Queued);
		expect(wakeups[0].source).toBe(WakeupSource.Timer);
		manager.shutdown();
	});

	it('does NOT enqueue when the run reported no work', async () => {
		const manager = createJobManager();
		const runId = await seedRun({ producedOutput: false, reportedNoWork: true });

		await callOnAgentComplete(manager, {
			success: true,
			exitCode: 0,
			stdout: '',
			stderr: '',
			heartbeatRunId: runId,
		});

		expect((await continuationWakeups()).length).toBe(0);
		manager.shutdown();
	});

	it('does NOT enqueue when the run produced no output', async () => {
		const manager = createJobManager();
		const runId = await seedRun({ producedOutput: false, reportedNoWork: false });

		await callOnAgentComplete(manager, {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: '',
			heartbeatRunId: runId,
		});

		expect((await continuationWakeups()).length).toBe(0);
		manager.shutdown();
	});

	it('does NOT enqueue when the task is no longer in_progress (handed off to review)', async () => {
		const manager = createJobManager();
		const runId = await seedRun({ producedOutput: true, reportedNoWork: false });
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Review,
			taskId,
		]);

		await callOnAgentComplete(manager, {
			success: true,
			exitCode: 0,
			stdout: '',
			stderr: '',
			heartbeatRunId: runId,
		});

		expect((await continuationWakeups()).length).toBe(0);
		manager.shutdown();
	});

	it('does NOT enqueue when the task was reassigned away from this agent', async () => {
		const manager = createJobManager();
		const runId = await seedRun({ producedOutput: true, reportedNoWork: false });
		await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [otherAgentId, taskId]);

		await callOnAgentComplete(manager, {
			success: true,
			exitCode: 0,
			stdout: '',
			stderr: '',
			heartbeatRunId: runId,
		});

		expect((await continuationWakeups()).length).toBe(0);
		manager.shutdown();
	});

	it('does NOT enqueue when the run handed off by waking another member on the same task', async () => {
		const manager = createJobManager();
		const runId = await seedRun({ producedOutput: true, reportedNoWork: false });
		// A peer @-mention/assignment during the run enqueues a wakeup for a
		// different member on this task — the "ball passed on" signal.
		await db.query(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload)
			 VALUES ($1, $2, $3::wakeup_source, $4::jsonb)`,
			[otherAgentId, teamId, WakeupSource.Mention, JSON.stringify({ task_id: taskId })],
		);

		await callOnAgentComplete(manager, {
			success: true,
			exitCode: 0,
			stdout: '',
			stderr: '',
			heartbeatRunId: runId,
		});

		expect((await continuationWakeups()).length).toBe(0);
		manager.shutdown();
	});
});
