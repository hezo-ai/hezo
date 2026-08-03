import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	AgentRuntimeStatus,
	ContainerStatus,
	HeartbeatRunStatus,
	UpdateState,
	WakeupSkipReason,
	WakeupStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
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
import {
	clearContainerCapacityForTest,
	removeSeededContainerProject,
	seedRunningContainerProject,
	setContainerCapacityForTest,
} from './helpers/capacity';

// This suite drives the run-scheduling, task-selection, dispatch, and budget /
// container-transition branches of JobManager that the existing
// job-manager{,-workflows}.test.ts files don't reach. Every manager is built
// from the real PGlite + Hono test context; docker is always a *complete*
// createStubDocker (never a partial), so the startup self-heal / sync passes
// that fire as side-effects never throw "x is not a function".

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
let secondAgentId: string;

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

	const teamRes = await createTestTeam(db, { name: 'Extended JM Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Extended JM Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string }>;
	agentId = agents[0].id;
	secondAgentId = agents[1].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ project_id: projectId, title: 'Extended Task', assignee_id: agentId }),
	});
	const createdTask = (await taskRes.json()).data;
	taskId = createdTask.id;

	// Pass activateAgent's designated-repo + container gates so a dispatch can
	// reach the launch path. Individual tests override container_status / repo as
	// needed to exercise the gates themselves.
	const repoRes = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, repo_identifier, host_type)
		 VALUES ($1, 'test-org/test-repo', 'github'::repo_host_type)
		 RETURNING id`,
		[projectId],
	);
	await db.query(
		`UPDATE projects
		 SET designated_repo_id = $1, container_id = 'test-container', container_status = 'running'
		 WHERE id = $2`,
		[repoRes.rows[0].id, projectId],
	);

	// Let the fire-and-forget assignment wakeup from task creation settle, then drop it.
	await waitForBackground();
	await db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		taskId,
	]);
});

afterEach(async () => {
	// Drain in-flight launchTask (background runAgent) promises before the next
	// test mutates the shared single-connection PGlite.
	await waitForBackground();
	// Common reset so each test starts from a clean scheduler-visible state.
	await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = ANY($1)', [
		[agentId, secondAgentId],
	]);
	await db.query(
		'UPDATE execution_locks SET released_at = now() WHERE member_id = ANY($1) AND released_at IS NULL',
		[[agentId, secondAgentId]],
	);
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
});

afterAll(async () => {
	await safeClose(db);
});

async function insertQueuedWakeup(
	memberId: string,
	source = 'mention',
	payload: Record<string, unknown> = { task_id: taskId },
	ageSeconds = 30,
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, created_at)
		 VALUES ($1, $2, $3::wakeup_source, 'queued'::wakeup_status, $4::jsonb,
		         now() - ($5 || ' seconds')::interval)
		 RETURNING id`,
		[memberId, teamId, source, JSON.stringify(payload), String(ageSeconds)],
	);
	return r.rows[0].id;
}

async function wakeupStatus(id: string): Promise<{
	status: string;
	last_skipped_reason: string | null;
	last_skipped_blocker_task_id: string | null;
}> {
	const r = await db.query<{
		status: string;
		last_skipped_reason: string | null;
		last_skipped_blocker_task_id: string | null;
	}>(
		`SELECT status, last_skipped_reason, last_skipped_blocker_task_id
		 FROM agent_wakeup_requests WHERE id = $1`,
		[id],
	);
	return r.rows[0];
}

describe('JobManager — extended coverage', () => {
	describe('live-run cancellation', () => {
		it('cancelLiveRun cancels the backing task and removes the live run', () => {
			const manager = createJobManager();
			const key = `${agentId}:${projectId}`;
			let aborted = false;
			manager.launchTask(
				key,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => {
							aborted = true;
							resolve();
						});
					}),
				60_000,
			);
			manager.registerLiveRun({
				runId: 'run-x',
				memberId: agentId,
				taskId,
				projectId,
				teamId,
				taskKey: key,
			});

			expect(manager.cancelLiveRun('run-x')).toBe(true);
			expect(manager.getLiveRunIds().has('run-x')).toBe(false);
			expect(aborted).toBe(true);
			// Unknown run id is a no-op false.
			expect(manager.cancelLiveRun('nope')).toBe(false);

			manager.shutdown();
		});

		it('cancelLiveRunsForProject cancels every run in the project and returns the count', () => {
			const manager = createJobManager();
			const keyA = `${agentId}:${projectId}`;
			const keyB = `${secondAgentId}:${projectId}`;
			const aborts: string[] = [];
			for (const [key, who] of [
				[keyA, 'a'],
				[keyB, 'b'],
			] as const) {
				manager.launchTask(
					key,
					(signal) =>
						new Promise<void>((resolve) => {
							signal.addEventListener('abort', () => {
								aborts.push(who);
								resolve();
							});
						}),
					60_000,
				);
			}
			manager.registerLiveRun({
				runId: 'r-a',
				memberId: agentId,
				taskId,
				projectId,
				teamId,
				taskKey: keyA,
			});
			manager.registerLiveRun({
				runId: 'r-b',
				memberId: secondAgentId,
				taskId,
				projectId,
				teamId,
				taskKey: keyB,
			});
			// A run in a different project must be left alone.
			manager.registerLiveRun({
				runId: 'r-other',
				memberId: agentId,
				taskId,
				projectId: 'other-project',
				teamId,
				taskKey: `${agentId}:other-project`,
			});

			const cancelled = manager.cancelLiveRunsForProject(projectId, 'container_stopped');
			expect(cancelled).toBe(2);
			expect(aborts.sort()).toEqual(['a', 'b']);
			expect(manager.getLiveRunIds()).toEqual(new Set(['r-other']));

			manager.shutdown();
		});
	});

	describe('dispatchWakeupNow gating', () => {
		it('returns task_busy and records the skip when the task already has an active run', async () => {
			const manager = createJobManager();
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[secondAgentId, teamId, taskId, HeartbeatRunStatus.Running],
			);
			const wakeupId = await insertQueuedWakeup(agentId);

			const result = await manager.dispatchWakeupNow(wakeupId);
			expect(result).toEqual({ dispatched: false, reason: 'task_busy' });

			const ws = await wakeupStatus(wakeupId);
			expect(ws.status).toBe(WakeupStatus.Queued);
			expect(ws.last_skipped_reason).toBe(WakeupSkipReason.TaskBusy);
			expect(ws.last_skipped_blocker_task_id).toBe(taskId);

			manager.shutdown();
		});

		it('returns instance_at_capacity when starting a container would exceed the limit', async () => {
			const manager = createJobManager();
			// Container semantics: this project's container is stopped, the limit is
			// 1, and a filler project's running container consumes the only slot.
			await setContainerCapacityForTest(db, 1);
			await db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [projectId]);
			await seedRunningContainerProject(db, 'cap-filler-dispatch');
			const wakeupId = await insertQueuedWakeup(agentId);

			const result = await manager.dispatchWakeupNow(wakeupId);
			expect(result).toEqual({ dispatched: false, reason: 'instance_at_capacity' });
			const ws = await wakeupStatus(wakeupId);
			expect(ws.status).toBe(WakeupStatus.Queued);
			expect(ws.last_skipped_reason).toBe(WakeupSkipReason.InstanceAtCapacity);

			await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [projectId]);
			await removeSeededContainerProject(db, 'cap-filler-dispatch');
			await clearContainerCapacityForTest(db);
			manager.shutdown();
		});

		it('returns agent_busy when the same agent already runs in the project', async () => {
			const manager = createJobManager();

			const sibRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), ...json },
				body: JSON.stringify({ project_id: projectId, title: 'Agent busy', assignee_id: agentId }),
			});
			const sibId = (await sibRes.json()).data.id as string;
			// Same agent already has an in-flight run in this project (on a different task),
			// but the project is below capacity, so only the per-agent guard trips.
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[agentId, teamId, sibId, HeartbeatRunStatus.Running],
			);
			const wakeupId = await insertQueuedWakeup(agentId);

			const result = await manager.dispatchWakeupNow(wakeupId);
			expect(result).toEqual({ dispatched: false, reason: 'agent_busy' });
			const ws = await wakeupStatus(wakeupId);
			expect(ws.status).toBe(WakeupStatus.Queued);
			expect(ws.last_skipped_reason).toBe(WakeupSkipReason.AgentRunning);

			await db.query('DELETE FROM tasks WHERE id = $1', [sibId]);
			manager.shutdown();
		});

		it('defers the wakeup (blocked) when the target task has an open blocker', async () => {
			const manager = createJobManager();

			const blockerRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), ...json },
				body: JSON.stringify({
					project_id: projectId,
					title: 'Open blocker',
					assignee_id: secondAgentId,
				}),
			});
			const blockerId = (await blockerRes.json()).data.id as string;
			await db.query(
				`INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)`,
				[taskId, blockerId],
			);
			// 'assignment' is a blocker-gated source; the blocker is non-terminal.
			const wakeupId = await insertQueuedWakeup(agentId, 'assignment');

			const result = await manager.dispatchWakeupNow(wakeupId);
			expect(result).toEqual({ dispatched: false, reason: 'blocked' });
			const r = await db.query<{ status: string; payload: Record<string, unknown> }>(
				'SELECT status, payload FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Deferred);
			expect(r.rows[0].payload.reason).toBe('blocked');

			await db.query('DELETE FROM task_dependencies WHERE task_id = $1', [taskId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [blockerId]);
			manager.shutdown();
		});

		it('marks the wakeup failed and rethrows when activateAgent throws', async () => {
			// activateAgent broadcasts the agent's Active status synchronously (before
			// launchTask). A wsManager that throws only on the member_agents table makes
			// activateAgent throw inside dispatchWakeupNow's try, exercising the
			// catch (mark Failed) + rethrow branch — without disturbing the earlier
			// tasks broadcast.
			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query(
				`UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1`,
				[projectId],
			);
			const throwingWs = {
				broadcast: (_room: string, msg: { table: string }) => {
					if (msg.table === 'member_agents') throw new Error('synthetic broadcast failure');
				},
			} as unknown as JobManagerDeps['wsManager'];
			const manager = createJobManager({ wsManager: throwingWs });
			const wakeupId = await insertQueuedWakeup(agentId);

			await expect(manager.dispatchWakeupNow(wakeupId)).rejects.toThrow(
				'synthetic broadcast failure',
			);
			await waitForBackground();

			const r = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Failed);

			// Release the lock activateAgent inserted before throwing, so it doesn't
			// linger into the next test's view.
			await db.query(
				'UPDATE execution_locks SET released_at = now() WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
				[taskId, agentId],
			);
			manager.shutdown();
		});
	});

	describe('processWakeups gating branches', () => {
		it('skips a task wakeup with agent_running when the agent already runs in the project', async () => {
			const manager = createJobManager();

			const sibRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), ...json },
				body: JSON.stringify({ project_id: projectId, title: 'Busy sib', assignee_id: agentId }),
			});
			const sibId = (await sibRes.json()).data.id as string;
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[agentId, teamId, sibId, HeartbeatRunStatus.Running],
			);
			const wakeupId = await insertQueuedWakeup(agentId);

			await (manager as unknown as { processWakeups(): Promise<void> }).processWakeups();

			const ws = await wakeupStatus(wakeupId);
			expect(ws.status).toBe(WakeupStatus.Queued);
			expect(ws.last_skipped_reason).toBe(WakeupSkipReason.AgentRunning);

			await db.query('DELETE FROM tasks WHERE id = $1', [sibId]);
			manager.shutdown();
		});

		it('retires a stale assignment wakeup already served by a completed run', async () => {
			const manager = createJobManager();
			// A completed run that started AFTER the wakeup was created — so the run
			// read the task at boot and served the assignment, making the still-queued
			// sibling wakeup redundant.
			const wakeupId = await insertQueuedWakeup(agentId, 'assignment', { task_id: taskId }, 120);
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at, exit_code)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '30 seconds', now() - interval '10 seconds', 0)`,
				[agentId, teamId, taskId, HeartbeatRunStatus.Succeeded],
			);

			await (manager as unknown as { processWakeups(): Promise<void> }).processWakeups();

			const r = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Coalesced);

			manager.shutdown();
		});

		it('defers a blocker-gated wakeup whose task has an open blocker', async () => {
			const manager = createJobManager();
			const blockerRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), ...json },
				body: JSON.stringify({
					project_id: projectId,
					title: 'PW blocker',
					assignee_id: secondAgentId,
				}),
			});
			const blockerId = (await blockerRes.json()).data.id as string;
			await db.query(
				`INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)`,
				[taskId, blockerId],
			);
			const wakeupId = await insertQueuedWakeup(agentId, 'assignment');

			await (manager as unknown as { processWakeups(): Promise<void> }).processWakeups();

			const r = await db.query<{ status: string; payload: Record<string, unknown> }>(
				'SELECT status, payload FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Deferred);
			expect(r.rows[0].payload.reason).toBe('blocked');

			await db.query('DELETE FROM task_dependencies WHERE task_id = $1', [taskId]);
			await db.query('DELETE FROM tasks WHERE id = $1', [blockerId]);
			manager.shutdown();
		});
	});

	describe('activateAgent re-queue and gate branches', () => {
		beforeEach(async () => {
			// Default healthy project state for this block: container up, capacity
			// available, repo designated, no budget limit and no prior spend, agent
			// idle and enabled. Each test then perturbs exactly one gate.
			const repo = await db.query<{ id: string }>(
				'SELECT id FROM repos WHERE project_id = $1 LIMIT 1',
				[projectId],
			);
			await db.query(
				`UPDATE projects
				 SET container_id = 'test-container', container_status = 'running',
				     designated_repo_id = $2
				 WHERE id = $1`,
				[projectId, repo.rows[0].id],
			);
			await db.query('UPDATE tasks SET assignee_id = $1 WHERE id = $2', [agentId, taskId]);
			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
			await db.query(
				`UPDATE member_agents
				 SET daily_budget_cents = 0, weekly_budget_cents = 0, monthly_budget_cents = 0,
				     touches_code = false, runtime_status = $1, admin_status = 'enabled'
				 WHERE id = $2`,
				[AgentRuntimeStatus.Idle, agentId],
			);
		});

		it('re-queues the wakeup when the container limit is reached at activation time', async () => {
			const manager = createJobManager();
			// The project's container is stopped and a filler project's running
			// container consumes the single slot, so activation must re-queue.
			await setContainerCapacityForTest(db, 1);
			await db.query(`UPDATE projects SET container_status = 'stopped' WHERE id = $1`, [projectId]);
			await seedRunningContainerProject(db, 'cap-filler-activate');
			const wakeupId = await insertQueuedWakeup(agentId, 'mention');
			await db.query("UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1", [
				wakeupId,
			]);

			await (
				manager as unknown as {
					activateAgent(
						m: string,
						t: string,
						w: string,
						p: Record<string, unknown>,
						s: string,
					): Promise<void>;
				}
			).activateAgent(agentId, teamId, wakeupId, { task_id: taskId }, 'mention');

			const r = await db.query<{ status: string; claimed_at: string | null }>(
				'SELECT status, claimed_at FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Queued);
			expect(r.rows[0].claimed_at).toBeNull();

			await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [projectId]);
			await removeSeededContainerProject(db, 'cap-filler-activate');
			await clearContainerCapacityForTest(db);
			manager.shutdown();
		});

		it('re-queues the wakeup when the agent is already busy in the project at activation time', async () => {
			const manager = createJobManager();
			const sibRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(token), ...json },
				body: JSON.stringify({ project_id: projectId, title: 'Busy2', assignee_id: agentId }),
			});
			const sibId = (await sibRes.json()).data.id as string;
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[agentId, teamId, sibId, HeartbeatRunStatus.Running],
			);
			const wakeupId = await insertQueuedWakeup(agentId, 'mention');
			await db.query("UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1", [
				wakeupId,
			]);

			await (
				manager as unknown as {
					activateAgent(
						m: string,
						t: string,
						w: string,
						p: Record<string, unknown>,
						s: string,
					): Promise<void>;
				}
			).activateAgent(agentId, teamId, wakeupId, { task_id: taskId }, 'mention');

			const r = await db.query<{ status: string }>(
				'SELECT status FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Queued);

			await db.query('DELETE FROM tasks WHERE id = $1', [sibId]);
			manager.shutdown();
		});

		it('pauses the agent and marks the wakeup over_budget when the agent is over its daily budget', async () => {
			const manager = createJobManager();
			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
			await db.query(
				'UPDATE member_agents SET daily_budget_cents = 100, runtime_status = $1 WHERE id = $2',
				[AgentRuntimeStatus.Idle, agentId],
			);
			await db.query(
				`INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 500)`,
				[agentId, projectId],
			);
			const wakeupId = await insertQueuedWakeup(agentId, 'mention');
			await db.query("UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1", [
				wakeupId,
			]);

			await (
				manager as unknown as {
					activateAgent(
						m: string,
						t: string,
						w: string,
						p: Record<string, unknown>,
						s: string,
					): Promise<void>;
				}
			).activateAgent(agentId, teamId, wakeupId, { task_id: taskId }, 'mention');

			// The budget gate records the skip reason (markWakeupSkipped leaves the
			// status as-is — here 'claimed') and reactively pauses the agent.
			const ws = await wakeupStatus(wakeupId);
			expect(ws.last_skipped_reason).toBe(WakeupSkipReason.OverBudget);

			const agent = await db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.OutOfAgentBudget);

			// No heartbeat run was created (budget gate skips before launch).
			const runs = await db.query<{ c: string }>(
				'SELECT count(*)::text AS c FROM heartbeat_runs WHERE task_id = $1',
				[taskId],
			);
			expect(runs.rows[0].c).toBe('0');

			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
			await db.query(
				'UPDATE member_agents SET daily_budget_cents = 0, runtime_status = $1 WHERE id = $2',
				[AgentRuntimeStatus.Idle, agentId],
			);
			manager.shutdown();
		});

		it('defers a code-touching wakeup with awaiting_repo_setup when the project has no designated repo', async () => {
			const manager = createJobManager();
			// Code-touching agent + no designated repo + a non-conversational source
			// (timer) hits the repo-setup gate.
			await db.query('UPDATE member_agents SET touches_code = true WHERE id = $1', [agentId]);
			await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);
			const wakeupId = await insertQueuedWakeup(agentId, 'timer');
			await db.query("UPDATE agent_wakeup_requests SET status = 'claimed' WHERE id = $1", [
				wakeupId,
			]);

			await (
				manager as unknown as {
					activateAgent(
						m: string,
						t: string,
						w: string,
						p: Record<string, unknown>,
						s: string,
					): Promise<void>;
				}
			).activateAgent(agentId, teamId, wakeupId, { task_id: taskId }, 'timer');

			const r = await db.query<{ status: string; payload: Record<string, unknown> }>(
				'SELECT status, payload FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Deferred);
			expect(r.rows[0].payload.reason).toBe('awaiting_repo_setup');
			expect(r.rows[0].payload.task_id).toBe(taskId);

			// Restore the designated repo for downstream tests.
			const repo = await db.query<{ id: string }>(
				'SELECT id FROM repos WHERE project_id = $1 LIMIT 1',
				[projectId],
			);
			await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
				repo.rows[0].id,
				projectId,
			]);
			manager.shutdown();
		});
	});

	describe('postFailurePing error truncation', () => {
		it('truncates an over-long run error to 500 chars + ellipsis in the system comment', async () => {
			const manager = createJobManager();
			const longError = 'E'.repeat(900);
			const run = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, error, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, $5, now())
				 RETURNING id`,
				[agentId, teamId, taskId, HeartbeatRunStatus.Failed, longError],
			);
			await db.query("DELETE FROM task_comments WHERE task_id = $1 AND content_type = 'system'", [
				taskId,
			]);

			await (
				manager as unknown as {
					onAgentComplete(
						m: string,
						s: string,
						t: string,
						ti: string,
						team: string,
						w: string | undefined,
						p: Record<string, unknown> | undefined,
						r: {
							success: boolean;
							exitCode: number;
							stdout: string;
							stderr: string;
							heartbeatRunId: string;
						},
					): Promise<void>;
				}
			).onAgentComplete(agentId, 'researcher', taskId, 'EXT-1', teamId, undefined, undefined, {
				success: false,
				exitCode: -1,
				stdout: '',
				stderr: longError,
				heartbeatRunId: run.rows[0].id,
			});

			const comment = await db.query<{ content: { error: string } }>(
				`SELECT content FROM task_comments
				 WHERE task_id = $1 AND content_type = 'system' AND content->>'kind' = 'run_failed'
				 ORDER BY created_at DESC LIMIT 1`,
				[taskId],
			);
			const err = comment.rows[0].content.error;
			expect(err.endsWith('…')).toBe(true);
			// 500 chars + the single-character ellipsis.
			expect(err.length).toBe(501);

			await db.query("DELETE FROM task_comments WHERE task_id = $1 AND content_type = 'system'", [
				taskId,
			]);
			manager.shutdown();
		});
	});

	describe('container transition handling', () => {
		it('handleContainerTransition fails project runs and cancels live runs on running→error', async () => {
			const manager = createJobManager();
			const key = `${agentId}:${projectId}`;
			let aborted = false;
			manager.launchTask(
				key,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => {
							aborted = true;
							resolve();
						});
					}),
				60_000,
			);
			const run = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())
				 RETURNING id`,
				[agentId, teamId, taskId, HeartbeatRunStatus.Running],
			);
			manager.registerLiveRun({
				runId: run.rows[0].id,
				memberId: agentId,
				taskId,
				projectId,
				teamId,
				taskKey: key,
			});

			await (
				manager as unknown as {
					handleContainerTransition(t: {
						projectId: string;
						projectSlug: string;
						teamId: string;
						oldStatus: string;
						newStatus: string;
					}): Promise<void>;
				}
			).handleContainerTransition({
				projectId,
				projectSlug,
				teamId,
				oldStatus: ContainerStatus.Running,
				newStatus: ContainerStatus.Error,
			});

			expect(aborted).toBe(true);
			expect(manager.getLiveRunIds().has(run.rows[0].id)).toBe(false);
			const r = await db.query<{ status: string }>(
				'SELECT status FROM heartbeat_runs WHERE id = $1',
				[run.rows[0].id],
			);
			expect(r.rows[0].status).toBe(HeartbeatRunStatus.Failed);

			await waitForBackground();
			manager.shutdown();
		});

		it('handleContainerTransition is a no-op for an unrelated transition (creating→running)', async () => {
			const manager = createJobManager();
			const run = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())
				 RETURNING id`,
				[agentId, teamId, taskId, HeartbeatRunStatus.Running],
			);

			await (
				manager as unknown as {
					handleContainerTransition(t: {
						projectId: string;
						projectSlug: string;
						teamId: string;
						oldStatus: string;
						newStatus: string;
					}): Promise<void>;
				}
			).handleContainerTransition({
				projectId,
				projectSlug,
				teamId,
				oldStatus: ContainerStatus.Creating,
				newStatus: ContainerStatus.Running,
			});

			// Run untouched (still running) since the transition isn't a failure.
			const r = await db.query<{ status: string }>(
				'SELECT status FROM heartbeat_runs WHERE id = $1',
				[run.rows[0].id],
			);
			expect(r.rows[0].status).toBe(HeartbeatRunStatus.Running);
			manager.shutdown();
		});

		it('syncContainerStatuses returns early when Docker is unreachable', async () => {
			const manager = createJobManager({ docker: createStubDocker({ ping: async () => false }) });
			// Should not throw and should reach no transition logic.
			await (
				manager as unknown as { syncContainerStatuses(): Promise<void> }
			).syncContainerStatuses();
			manager.shutdown();
		});
	});

	describe('detectOrphanedRuns sweep', () => {
		it('runs detect + stale-dispatch sweep + heal without error', async () => {
			const manager = createJobManager();
			await (manager as unknown as { detectOrphanedRuns(): Promise<void> }).detectOrphanedRuns();
			manager.shutdown();
		});
	});

	describe('inbox archive sweep', () => {
		it('archives admin mentions read longer ago than the retention window', async () => {
			const manager = createJobManager();
			const userRes = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
			// admin_mentions needs a backing comment (FK). Seed one, then an old read mention.
			const commentRes = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, NULL, 'system'::comment_content_type, '{"kind":"test"}'::jsonb)
				 RETURNING id`,
				[taskId],
			);
			const mentionRes = await db.query<{ id: string }>(
				`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id, created_at, read_at, archived_at)
				 VALUES ($1, $2, $3, $4, now() - interval '100 days', now() - interval '100 days', NULL)
				 RETURNING id`,
				[teamId, taskId, commentRes.rows[0].id, userRes.rows[0].id],
			);

			await (manager as unknown as { archiveInboxItems(): Promise<void> }).archiveInboxItems();

			const archived = await db.query<{ archived_at: string | null }>(
				'SELECT archived_at FROM admin_mentions WHERE id = $1',
				[mentionRes.rows[0].id],
			);
			expect(archived.rows[0].archived_at).not.toBeNull();

			await db.query('DELETE FROM admin_mentions WHERE id = $1', [mentionRes.rows[0].id]);
			await db.query('DELETE FROM task_comments WHERE id = $1', [commentRes.rows[0].id]);
			manager.shutdown();
		});
	});

	describe('auto-update check', () => {
		it('checkForUpdate no-ops when not a supervised worker', async () => {
			const manager = createJobManager();
			// In the test runtime isSupervisedWorker() is false, so this returns
			// immediately without touching the filesystem / network.
			await (manager as unknown as { checkForUpdate(): Promise<void> }).checkForUpdate();
			manager.shutdown();
		});
	});

	describe('auto-install of staged updates', () => {
		type WithAutoInstall = { autoInstallStagedUpdate(): Promise<void> };

		async function seedUpdateState(state: UpdateState): Promise<void> {
			await mkdir(join(dataDir, '.update'), { recursive: true });
			await writeFile(
				join(dataDir, '.update', 'state.json'),
				JSON.stringify({ state, targetVersion: '9.9.9', updatedAt: Date.now() }),
			);
		}

		afterEach(async () => {
			await rm(join(dataDir, '.update'), { recursive: true, force: true });
		});

		it('restarts onto a staged update when idle', async () => {
			await seedUpdateState(UpdateState.Staged);
			let restarts = 0;
			const manager = createJobManager({
				autoInstallUpdates: true,
				isSupervisedWorker: () => true,
				requestUpdateRestart: async () => {
					restarts++;
				},
			});
			await (manager as unknown as WithAutoInstall).autoInstallStagedUpdate();
			expect(restarts).toBe(1);
			manager.shutdown();
		});

		it('defers the restart while agent runs are in flight, then installs once idle', async () => {
			await seedUpdateState(UpdateState.Staged);
			let restarts = 0;
			const manager = createJobManager({
				autoInstallUpdates: true,
				isSupervisedWorker: () => true,
				requestUpdateRestart: async () => {
					restarts++;
				},
			});
			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			manager.launchTask('auto-install-busy', () => gate, 60_000);

			await (manager as unknown as WithAutoInstall).autoInstallStagedUpdate();
			expect(restarts).toBe(0); // deferred — a run is in flight

			release();
			await waitForBackground();
			await (manager as unknown as WithAutoInstall).autoInstallStagedUpdate();
			expect(restarts).toBe(1); // next tick installs
			manager.shutdown();
		});

		it('does not restart when no update is staged', async () => {
			await seedUpdateState(UpdateState.Downloading);
			let restarts = 0;
			const manager = createJobManager({
				autoInstallUpdates: true,
				isSupervisedWorker: () => true,
				requestUpdateRestart: async () => {
					restarts++;
				},
			});
			await (manager as unknown as WithAutoInstall).autoInstallStagedUpdate();
			expect(restarts).toBe(0);
			manager.shutdown();
		});

		it('does not restart when not a supervised worker, even with a staged update', async () => {
			await seedUpdateState(UpdateState.Staged);
			let restarts = 0;
			const manager = createJobManager({
				autoInstallUpdates: true,
				// The env-derived default is also false in tests; pass it explicitly so
				// the assertion doesn't hinge on the test runtime's environment.
				isSupervisedWorker: () => false,
				requestUpdateRestart: async () => {
					restarts++;
				},
			});
			await (manager as unknown as WithAutoInstall).autoInstallStagedUpdate();
			expect(restarts).toBe(0);
			manager.shutdown();
		});
	});

	describe('startup container passes', () => {
		// HQ and other projects can be provisioned in the background during file
		// setup. Reset all container columns around each test so the passes only
		// see the row the test seeds.
		beforeEach(async () => {
			await db.query(
				`UPDATE projects SET container_status = NULL, container_id = NULL, container_error = NULL`,
			);
		});
		afterEach(async () => {
			await db.query(
				`UPDATE projects SET container_status = NULL, container_id = NULL, container_error = NULL`,
			);
			// Restore the working project's container for the rest of the suite.
			await db.query(
				`UPDATE projects SET container_id = 'test-container', container_status = 'running' WHERE id = $1`,
				[projectId],
			);
		});

		it('removes a running container whose /workspace mount is unreachable', async () => {
			// Removed rather than rebuilt: provisioning a replacement here races the
			// pool, which provisions one on the next run that needs it anyway, and
			// eagerly rebuilding meant a stale mount on an idle project paid for a
			// container nobody was waiting on.
			//
			// Drop the repo row so nothing downstream reaches for a clone. Restored
			// below.
			const savedRepo = await db.query<{ id: string; repo_identifier: string; host_type: string }>(
				'SELECT id, repo_identifier, host_type::text AS host_type FROM repos WHERE project_id = $1 LIMIT 1',
				[projectId],
			);
			await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);
			await db.query('DELETE FROM repos WHERE project_id = $1', [projectId]);
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status, container_id = 'stale-box' WHERE id = $1`,
				[projectId],
			);

			// Only the '/workspace' probe exec reports a non-zero exit (mount
			// unreachable); every other exec (used by the rebuild's bring-up)
			// succeeds, so the rebuild completes quietly.
			let probeExecId = '';
			let rebuilt = false;
			const removed: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					execCreate: async (_id: string, opts: { Cmd: string[] }) => {
						const isProbe = opts.Cmd.join(' ').includes('/workspace');
						const execId = isProbe ? 'probe-exec' : `exec-${Math.random()}`;
						if (isProbe) probeExecId = execId;
						return execId;
					},
					execStart: async () => ({ stdout: '', stderr: '' }),
					execInspect: async (execId: string) => ({
						ExitCode: execId === probeExecId ? 1 : 0,
						Running: false,
						Pid: 0,
					}),
					createContainer: async () => {
						rebuilt = true;
						return { Id: 'rebuilt-box', Warnings: [] };
					},
					removeContainer: async (id: string) => {
						removed.push(id);
					},
				}),
			});

			await (
				manager as unknown as { repairStaleContainerMounts(d: unknown): Promise<void> }
			).repairStaleContainerMounts(
				(manager as unknown as { deps: { docker: unknown } }).deps.docker,
			);

			expect(removed).toContain('stale-box');
			expect(rebuilt).toBe(false);

			// Restore the repo row + designation for the rest of the suite.
			const r = await db.query<{ id: string }>(
				`INSERT INTO repos (project_id, repo_identifier, host_type)
				 VALUES ($1, $2, $3::repo_host_type) RETURNING id`,
				[projectId, savedRepo.rows[0].repo_identifier, savedRepo.rows[0].host_type],
			);
			await db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
				r.rows[0].id,
				projectId,
			]);
			manager.shutdown();
		});

		it('self-heals an errored project by re-attaching to a live container', async () => {
			await db.query(
				`UPDATE projects SET container_status = 'error'::container_status, container_id = NULL WHERE id = $1`,
				[projectId],
			);

			const manager = createJobManager({
				docker: createStubDocker({
					findContainerByNamePrefix: async (name: string) => ({
						Id: 'live-box',
						Names: [`/${name}`],
						State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
						Config: { Image: 'stub' },
					}),
				}),
			});

			await (
				manager as unknown as { selfHealErroredContainers(d: unknown): Promise<void> }
			).selfHealErroredContainers(
				(manager as unknown as { deps: { docker: unknown } }).deps.docker,
			);

			const row = await db.query<{ container_id: string | null; container_status: string }>(
				'SELECT container_id, container_status FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_id).toBe('live-box');
			expect(row.rows[0].container_status).toBe(ContainerStatus.Running);
			manager.shutdown();
		});
	});

	describe('guarded job error handling', () => {
		it('swallows and logs an error thrown by a guarded job body', async () => {
			const manager = createJobManager();
			// guarded() must not let a throwing body escape — it logs and resets the guard.
			await expect(
				(
					manager as unknown as {
						guarded(name: string, fn: () => Promise<void>): Promise<void>;
					}
				).guarded('synthetic-test-job', async () => {
					throw new Error('expected: guarded swallows this');
				}),
			).resolves.toBeUndefined();
			manager.shutdown();
		});

		it('skips re-entrant guarded execution while the same job is in flight', async () => {
			const manager = createJobManager();
			let running = 0;
			let maxConcurrent = 0;
			let release: (() => void) | undefined;
			const body = () =>
				new Promise<void>((resolve) => {
					running++;
					maxConcurrent = Math.max(maxConcurrent, running);
					release = () => {
						running--;
						resolve();
					};
				});
			const guarded = (
				manager as unknown as { guarded(name: string, fn: () => Promise<void>): Promise<void> }
			).guarded.bind(manager);

			const first = guarded('reentrant-test', body);
			// Second call while the first is in flight must be skipped (no second body run).
			await guarded('reentrant-test', body);
			expect(maxConcurrent).toBe(1);
			release?.();
			await first;
			manager.shutdown();
		});
	});
});
