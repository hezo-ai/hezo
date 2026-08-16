import {
	AgentRuntimeStatus,
	CEO_AGENT_SLUG,
	HeartbeatRunStatus,
	TaskStatus,
	WakeupSkipReason,
	WakeupStatus,
} from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { clearRefreshFns, registerRefreshFn } from '../src/services/oauth/token-resolver';
import type { PricingService } from '../src/services/pricing';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// Scheduling / dispatch branches of JobManager: the run-now dispatch path end to
// end (claim, launch, completion bookkeeping, failure ping), the scheduled
// heartbeat pass, timeout continuations, chain-after-completion for instance
// agents, and the budget-resume sweep. Every dispatch runs the real runAgent
// against the stub docker: with no AI provider configured the run finalizes
// `failed` quickly and deterministically, which drives the full completion path.

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let taskIdentifier: string;
let agentId: string;
let secondAgentId: string;

const json = { 'Content-Type': 'application/json' };

/** Typed access to JobManager's private members without sprinkling `any`. */
interface JmInternals {
	processWakeups(): Promise<void>;
	processScheduledHeartbeats(): Promise<void>;
	processBudgetResumes(): Promise<void>;
	sweepConnectorHealth(): Promise<void>;
	activateAgent(
		memberId: string,
		teamId: string,
		wakeupId: string | undefined,
		payload: Record<string, unknown>,
		source: string,
	): Promise<void>;
	onAgentComplete(
		memberId: string,
		agentSlug: string,
		taskId: string,
		taskIdentifier: string,
		teamId: string,
		wakeupId: string | undefined,
		payload: Record<string, unknown> | undefined,
		result: {
			success: boolean;
			exitCode: number;
			stdout: string;
			stderr: string;
			durationMs?: number;
			heartbeatRunId?: string;
			timedOut?: boolean;
		},
	): Promise<void>;
	isAgentBusyInProject(memberId: string, projectId: string): Promise<boolean>;
	activeTaskRuns: Set<string>;
	activeProjectRuns: Map<string, number>;
	cron: { createJob(name: string, opts: unknown): unknown };
}

const internals = (m: JobManager) => m as unknown as JmInternals;

function createJobManager(overrides: Partial<JobManagerDeps> = {}): JobManager {
	return new JobManager({
		db: ctx.db,
		docker: createStubDocker(),
		masterKeyManager: ctx.masterKeyManager,
		serverPort: ctx.port,
		dataDir: ctx.dataDir,
		wsManager: { broadcast: () => {} } as unknown as JobManagerDeps['wsManager'],
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
		...overrides,
	});
}

beforeAll(async () => {
	ctx = await createTestContext();
	const { app, db, token } = ctx;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Sched JM Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Sched JM Project',
		description: 'Scheduling coverage project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agents = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug <> 'captain'
		 ORDER BY ma.slug`,
		[teamId],
	);
	agentId = agents.rows[0].id;
	secondAgentId = agents.rows[1].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ project_id: projectId, title: 'Sched Task', assignee_id: agentId }),
	});
	const createdTask = (await taskRes.json()).data;
	taskId = createdTask.id;
	taskIdentifier = createdTask.identifier;

	// Designated repo + running container so activateAgent's gates pass.
	const repoRes = await db.query<{ id: string }>(
		`INSERT INTO repos (project_id, repo_identifier, host_type)
		 VALUES ($1, 'test-org/sched-repo', 'github'::repo_host_type)
		 RETURNING id`,
		[projectId],
	);
	await db.query(
		`UPDATE projects
		 SET designated_repo_id = $1, container_id = 'sched-container',
		     container_status = 'running'
		 WHERE id = $2`,
		[repoRes.rows[0].id, projectId],
	);

	// Stamp every agent's heartbeat so nothing is spuriously "due"; individual
	// tests un-stamp the agent they target.
	await db.query('UPDATE member_agents SET last_heartbeat_at = now()');

	// Drop the fire-and-forget assignment wakeup from task creation.
	await waitForBackground();
	await ctx.db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		taskId,
	]);
});

afterEach(async () => {
	await waitForBackground();
	await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
	await ctx.db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');
	await ctx.db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
	await ctx.db.query(
		`UPDATE member_agents SET runtime_status = $1::agent_runtime_status,
		        daily_budget_cents = 0, last_heartbeat_at = now()
		 WHERE id = ANY($2)`,
		[AgentRuntimeStatus.Idle, [agentId, secondAgentId]],
	);
	await ctx.db.query('DELETE FROM cost_entries WHERE member_id = ANY($1)', [
		[agentId, secondAgentId],
	]);
	await ctx.db.query(
		`UPDATE projects SET container_id = 'sched-container', container_status = 'running'
		 WHERE id = $1`,
		[projectId],
	);
	await ctx.db.query("DELETE FROM task_comments WHERE task_id = $1 AND content_type = 'system'", [
		taskId,
	]);
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

async function insertQueuedWakeup(
	memberId: string,
	source = 'mention',
	payload: Record<string, unknown> = { task_id: taskId },
	status = 'queued',
	ageSeconds = 30,
): Promise<string> {
	const r = await ctx.db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, created_at)
		 VALUES ($1, $2, $3::wakeup_source, $4::wakeup_status, $5::jsonb,
		         now() - ($6 || ' seconds')::interval)
		 RETURNING id`,
		[memberId, teamId, source, status, JSON.stringify(payload), String(ageSeconds)],
	);
	return r.rows[0].id;
}

async function wakeupRow(id: string): Promise<{
	status: string;
	claimed_at: string | null;
	last_skipped_reason: string | null;
}> {
	const r = await ctx.db.query<{
		status: string;
		claimed_at: string | null;
		last_skipped_reason: string | null;
	}>(
		`SELECT status::text AS status, claimed_at, last_skipped_reason
		 FROM agent_wakeup_requests WHERE id = $1`,
		[id],
	);
	return r.rows[0];
}

describe('JobManager scheduling & dispatch', () => {
	describe('dispatchWakeupNow', () => {
		it('returns not_found for an unknown wakeup id', async () => {
			const manager = createJobManager();
			const result = await manager.dispatchWakeupNow('00000000-0000-0000-0000-0000000000aa');
			expect(result).toEqual({ dispatched: false, reason: 'not_found' });
			manager.shutdown();
		});

		it('returns not_queued when the wakeup is no longer queued', async () => {
			const manager = createJobManager();
			const wakeupId = await insertQueuedWakeup(
				agentId,
				'mention',
				{ task_id: taskId },
				'completed',
			);
			const result = await manager.dispatchWakeupNow(wakeupId);
			expect(result).toEqual({ dispatched: false, reason: 'not_queued' });
			manager.shutdown();
		});

		it('defers a blocker-gated wakeup whose task has an open blocker', async () => {
			const manager = createJobManager();
			const blockerRes = await ctx.app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(ctx.token), ...json },
				body: JSON.stringify({
					project_id: projectId,
					title: 'Sched blocker',
					assignee_id: secondAgentId,
				}),
			});
			const blockerId = (await blockerRes.json()).data.id as string;
			await ctx.db.query(
				'INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)',
				[taskId, blockerId],
			);
			const wakeupId = await insertQueuedWakeup(agentId, 'assignment');

			const result = await manager.dispatchWakeupNow(wakeupId);
			expect(result).toEqual({ dispatched: false, reason: 'blocked' });
			const r = await ctx.db.query<{ status: string; payload: Record<string, unknown> }>(
				'SELECT status, payload FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Deferred);
			expect(r.rows[0].payload.reason).toBe('blocked');

			await ctx.db.query('DELETE FROM task_dependencies WHERE task_id = $1', [taskId]);
			await ctx.db.query('DELETE FROM tasks WHERE id = $1', [blockerId]);
			manager.shutdown();
		});

		it('claims and dispatches a healthy wakeup end to end, absorbing queued siblings', async () => {
			const broadcasts: Array<{ table: string; type?: string }> = [];
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string }) => broadcasts.push(msg),
				} as unknown as JobManagerDeps['wsManager'],
			});
			const wakeupId = await insertQueuedWakeup(agentId, 'mention');
			// A queued sibling for the same agent+task, older than the dispatched one:
			// the launched run reads the task at boot, so the sibling is redundant.
			const siblingId = await insertQueuedWakeup(
				agentId,
				'comment',
				{ task_id: taskId },
				'queued',
				60,
			);

			const result = await manager.dispatchWakeupNow(wakeupId);
			expect(result).toEqual({ dispatched: true });

			// The sibling was absorbed synchronously by the launch.
			const sibling = await wakeupRow(siblingId);
			expect(sibling.status).toBe(WakeupStatus.Coalesced);

			// The claim broadcast the refreshed task row.
			expect(broadcasts.some((b) => b.table === 'tasks')).toBe(true);
			expect(broadcasts.some((b) => b.table === 'member_agents')).toBe(true);

			// Let the background run settle: with no AI provider configured the run
			// finalizes failed, and the completion path does its bookkeeping.
			await waitForBackground();

			const run = await ctx.db.query<{ status: string; error: string | null }>(
				'SELECT status::text AS status, error FROM heartbeat_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1',
				[taskId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			expect(run.rows[0].error).toContain('No verified AI provider credential');

			// Wakeup resolved to failed (run failed), lock released, agent idle again.
			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Failed);
			const locks = await ctx.db.query(
				'SELECT 1 FROM execution_locks WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
				[taskId, agentId],
			);
			expect(locks.rows.length).toBe(0);
			const agent = await ctx.db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);

			// The failed run posted a run_failed system comment (failure ping).
			const ping = await ctx.db.query<{ content: { kind: string; error: string } }>(
				`SELECT content FROM task_comments
				 WHERE task_id = $1 AND content_type = 'system' AND content->>'kind' = 'run_failed'`,
				[taskId],
			);
			expect(ping.rows.length).toBe(1);
			expect(ping.rows[0].content.error).toContain('No verified AI provider credential');

			// In-memory dispatch guards are released.
			expect(internals(manager).activeTaskRuns.has(taskId)).toBe(false);
			expect(internals(manager).activeProjectRuns.has(projectId)).toBe(false);

			manager.shutdown();
		});
	});

	describe('processWakeups branches', () => {
		it('skips a task-less wakeup with agent_running while the member is running anywhere', async () => {
			const manager = createJobManager();
			manager.launchTask(
				`${agentId}:${projectId}`,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
					}),
				60_000,
			);
			const wakeupId = await insertQueuedWakeup(agentId, 'heartbeat', {});

			await (manager as unknown as JmInternals).processWakeups();

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Queued);
			expect(w.last_skipped_reason).toBe(WakeupSkipReason.AgentRunning);
			manager.shutdown();
		});

		it('retires a stale assignment wakeup already served by a completed run', async () => {
			const broadcasts: Array<{ table: string }> = [];
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string }) => broadcasts.push(msg),
				} as unknown as JobManagerDeps['wsManager'],
			});
			const wakeupId = await insertQueuedWakeup(
				agentId,
				'assignment',
				{ task_id: taskId },
				'queued',
				120,
			);
			await ctx.db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at, exit_code)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '30 seconds', now() - interval '5 seconds', 0)`,
				[agentId, teamId, taskId, HeartbeatRunStatus.Succeeded],
			);

			await (manager as unknown as JmInternals).processWakeups();

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Coalesced);
			// The retirement re-broadcast the task so the badge clears.
			expect(broadcasts.some((b) => b.table === 'tasks')).toBe(true);
			manager.shutdown();
		});

		it('marks the wakeup failed when activateAgent throws mid-dispatch', async () => {
			// A wsManager that throws only on member_agents makes activateAgent throw
			// after the claim, exercising processWakeups' catch branch.
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string }) => {
						if (msg.table === 'member_agents') throw new Error('synthetic broadcast failure');
					},
				} as unknown as JobManagerDeps['wsManager'],
			});
			const wakeupId = await insertQueuedWakeup(agentId, 'mention');

			await (manager as unknown as JmInternals).processWakeups();

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Failed);
			manager.shutdown();
		});
	});

	describe('processScheduledHeartbeats', () => {
		it('creates a claimed heartbeat wakeup and dispatches a due agent with pending work', async () => {
			const manager = createJobManager();
			await ctx.db.query('UPDATE member_agents SET last_heartbeat_at = NULL WHERE id = $1', [
				agentId,
			]);

			await (manager as unknown as JmInternals).processScheduledHeartbeats();
			await waitForBackground();

			const wakeups = await ctx.db.query<{ status: string; payload: Record<string, unknown> }>(
				`SELECT status::text AS status, payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'heartbeat'::wakeup_source`,
				[agentId],
			);
			expect(wakeups.rows.length).toBe(1);
			expect(wakeups.rows[0].payload.reason).toBe('scheduled_heartbeat');
			// The dispatched run selected the agent's assigned task and executed
			// (failing on the missing AI provider), so a run row exists for it.
			const runs = await ctx.db.query<{ status: string }>(
				'SELECT status::text AS status FROM heartbeat_runs WHERE member_id = $1 AND task_id = $2',
				[agentId, taskId],
			);
			expect(runs.rows.length).toBe(1);
			expect(runs.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			// The run's completion resolved the heartbeat wakeup.
			expect(wakeups.rows[0].status).toBe(WakeupStatus.Failed);
			manager.shutdown();
		});

		it('skips a due agent that is already running', async () => {
			const manager = createJobManager();
			await ctx.db.query('UPDATE member_agents SET last_heartbeat_at = NULL WHERE id = $1', [
				agentId,
			]);
			manager.launchTask(
				`${agentId}:${projectId}`,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
					}),
				60_000,
			);

			await (manager as unknown as JmInternals).processScheduledHeartbeats();

			const wakeups = await ctx.db.query(
				`SELECT 1 FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'heartbeat'::wakeup_source`,
				[agentId],
			);
			expect(wakeups.rows.length).toBe(0);
			manager.shutdown();
		});
	});

	describe('no-work backoff', () => {
		/**
		 * A finished no-work run for the shared agent+task, `minutesAgo` back.
		 *
		 * Clears the task's comments first. The backoff lifts on any comment newer
		 * than the run, and earlier tests in this file leave text comments on the
		 * shared task at real `now()` - which is newer than a backdated run, so they
		 * would lift it before the assertion ran. (afterEach only sweeps `system`.)
		 */
		async function seedNoWorkRun(minutesAgo: number): Promise<void> {
			await ctx.db.query('DELETE FROM task_comments WHERE task_id = $1', [taskId]);
			await ctx.db.query(
				`INSERT INTO heartbeat_runs
				   (team_id, member_id, task_id, status, started_at, finished_at, reported_no_work)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status,
				         now() - ($5 || ' minutes')::interval - interval '1 minute',
				         now() - ($5 || ' minutes')::interval, true)`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Succeeded, String(minutesAgo)],
			);
		}

		it('skips a container_start dispatch minutes after the agent reported no work', async () => {
			// The incident, end to end. A daily agent finishes a run having called
			// report_no_work; the container_start automation fires minutes later and
			// used to dispatch a full billed run to reach the same conclusion, over
			// and over, while the UI showed the next heartbeat a day away.
			await ctx.db.query('UPDATE member_agents SET heartbeat_interval_min = 1440 WHERE id = $1', [
				agentId,
			]);
			await seedNoWorkRun(5);
			const wakeupId = await insertQueuedWakeup(agentId, 'automation', {
				task_id: taskId,
				reason: 'container_start',
			});

			const manager = createJobManager();
			await internals(manager).processWakeups();
			await waitForBackground();

			const row = await wakeupRow(wakeupId);
			// Completed, with the reason recorded: answered, not left dangling and not
			// re-queued to ask again.
			expect(row.status).toBe(WakeupStatus.Completed);
			expect(row.last_skipped_reason).toBe(WakeupSkipReason.NoWorkCooldown);
			// The point of the whole change: no second run, so no second bill.
			const runs = await ctx.db.query<{ id: string }>(
				`SELECT id FROM heartbeat_runs
				 WHERE member_id = $1 AND task_id = $2 AND reported_no_work = false`,
				[agentId, taskId],
			);
			expect(runs.rows.length).toBe(0);
			manager.shutdown();
		});

		it('dispatches anyway once new input lands on the task', async () => {
			await ctx.db.query('UPDATE member_agents SET heartbeat_interval_min = 1440 WHERE id = $1', [
				agentId,
			]);
			await seedNoWorkRun(5);
			// A human comment after the run - the backoff must not sit on this.
			await ctx.db.query(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, NULL, 'text'::comment_content_type, $2::jsonb)`,
				[taskId, JSON.stringify({ text: 'actually, there is something' })],
			);
			const wakeupId = await insertQueuedWakeup(agentId, 'automation', {
				task_id: taskId,
				reason: 'container_start',
			});

			const manager = createJobManager();
			await internals(manager).processWakeups();
			await waitForBackground();

			const row = await wakeupRow(wakeupId);
			expect(row.last_skipped_reason).not.toBe(WakeupSkipReason.NoWorkCooldown);
			// It really ran (and failed on the absent AI provider, as everything in
			// this file does) rather than merely avoiding the skip.
			const runs = await ctx.db.query<{ id: string }>(
				`SELECT id FROM heartbeat_runs
				 WHERE member_id = $1 AND task_id = $2 AND reported_no_work = false`,
				[agentId, taskId],
			);
			expect(runs.rows.length).toBe(1);
			manager.shutdown();
		});

		it('never sits on a mention, however recent the no-work verdict', async () => {
			await ctx.db.query('UPDATE member_agents SET heartbeat_interval_min = 1440 WHERE id = $1', [
				agentId,
			]);
			await seedNoWorkRun(1);
			const wakeupId = await insertQueuedWakeup(agentId, 'mention', { task_id: taskId });

			const manager = createJobManager();
			await internals(manager).processWakeups();
			await waitForBackground();

			const row = await wakeupRow(wakeupId);
			expect(row.last_skipped_reason).not.toBe(WakeupSkipReason.NoWorkCooldown);
			manager.shutdown();
		});
	});

	describe('processBudgetResumes', () => {
		it('lifts a reactive budget pause once the agent is back within budget', async () => {
			const manager = createJobManager();
			await ctx.db.query(
				`UPDATE member_agents SET runtime_status = $1::agent_runtime_status, daily_budget_cents = 1000
				 WHERE id = $2`,
				[AgentRuntimeStatus.OutOfAgentBudget, agentId],
			);

			await (manager as unknown as JmInternals).processBudgetResumes();

			const agent = await ctx.db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
			manager.shutdown();
		});

		it('keeps the pause while the agent is still over budget', async () => {
			const manager = createJobManager();
			await ctx.db.query(
				`UPDATE member_agents SET runtime_status = $1::agent_runtime_status, daily_budget_cents = 100
				 WHERE id = $2`,
				[AgentRuntimeStatus.OutOfAgentBudget, agentId],
			);
			await ctx.db.query(
				'INSERT INTO cost_entries (member_id, project_id, amount_cents) VALUES ($1, $2, 500)',
				[agentId, projectId],
			);

			await (manager as unknown as JmInternals).processBudgetResumes();

			const agent = await ctx.db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.OutOfAgentBudget);
			manager.shutdown();
		});
	});

	describe('activateAgent launch-conflict undo', () => {
		it('undoes the lock and status side-effects and re-queues when launchTask is refused', async () => {
			const manager = createJobManager();
			// Occupy the agent's per-project key so launchTask refuses the dispatch,
			// and bypass the earlier busy pre-check to simulate the race the undo
			// branch exists for (key grabbed between the check and the launch).
			manager.launchTask(
				`${agentId}:${projectId}`,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => resolve());
					}),
				60_000,
			);
			(
				manager as unknown as { isAgentBusyInProject: () => Promise<boolean> }
			).isAgentBusyInProject = async () => false;

			const wakeupId = await insertQueuedWakeup(agentId, 'mention', { task_id: taskId }, 'claimed');
			await (manager as unknown as JmInternals).activateAgent(
				agentId,
				teamId,
				wakeupId,
				{ task_id: taskId },
				'mention',
			);

			const w = await wakeupRow(wakeupId);
			expect(w.status).toBe(WakeupStatus.Queued);
			expect(w.claimed_at).toBeNull();
			const locks = await ctx.db.query(
				'SELECT 1 FROM execution_locks WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
				[taskId, agentId],
			);
			expect(locks.rows.length).toBe(0);
			const agent = await ctx.db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
			expect(internals(manager).activeTaskRuns.has(taskId)).toBe(false);
			expect(internals(manager).activeProjectRuns.has(projectId)).toBe(false);
			manager.shutdown();
		});
	});

	describe('timeout continuations', () => {
		async function seedRun(status: HeartbeatRunStatus, ageSeconds: number): Promise<string> {
			const r = await ctx.db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - ($5 || ' seconds')::interval)
				 RETURNING id`,
				[agentId, teamId, taskId, status, String(ageSeconds)],
			);
			return r.rows[0].id;
		}

		it('queues a same-task continuation after a timed-out run and skips the failure ping', async () => {
			const manager = createJobManager();
			const runId = await seedRun(HeartbeatRunStatus.TimedOut, 10);

			await (manager as unknown as JmInternals).onAgentComplete(
				agentId,
				'engineer',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{
					success: false,
					exitCode: -1,
					stdout: '',
					stderr: 'timed out',
					heartbeatRunId: runId,
					timedOut: true,
				},
			);

			const continuation = await ctx.db.query<{ payload: Record<string, unknown> }>(
				`SELECT payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'timer'::wakeup_source`,
				[agentId],
			);
			expect(continuation.rows.length).toBe(1);
			expect(continuation.rows[0].payload.reason).toBe('timeout_continuation');
			expect(continuation.rows[0].payload.task_id).toBe(taskId);

			// No failure ping — the timeout continuation supersedes it.
			const pings = await ctx.db.query(
				`SELECT 1 FROM task_comments WHERE task_id = $1 AND content->>'kind' = 'run_failed'`,
				[taskId],
			);
			expect(pings.rows.length).toBe(0);
			manager.shutdown();
		});

		it('stops re-queuing after the consecutive-timeout cap and suppresses the ping on a long streak', async () => {
			const manager = createJobManager();
			// Five consecutive timeouts — the cap. The most recent is the run
			// completing now.
			let lastRunId = '';
			for (let i = 5; i >= 1; i--) {
				lastRunId = await seedRun(HeartbeatRunStatus.TimedOut, i * 10);
			}

			await (manager as unknown as JmInternals).onAgentComplete(
				agentId,
				'engineer',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{
					success: false,
					exitCode: -1,
					stdout: '',
					stderr: 'timed out again',
					heartbeatRunId: lastRunId,
					timedOut: true,
				},
			);

			// The cap declined the continuation…
			const continuation = await ctx.db.query(
				`SELECT 1 FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'timer'::wakeup_source
				   AND payload->>'reason' = 'timeout_continuation'`,
				[agentId],
			);
			expect(continuation.rows.length).toBe(0);
			// …and the fallback failure ping is suppressed by the 3-failure streak.
			const pings = await ctx.db.query(
				`SELECT 1 FROM task_comments WHERE task_id = $1 AND content->>'kind' = 'run_failed'`,
				[taskId],
			);
			expect(pings.rows.length).toBe(0);
			manager.shutdown();
		});
	});

	describe('repo-setup gate', () => {
		it('defers a code-touching wakeup awaiting repo setup even when the setup broadcast throws', async () => {
			// The ensure-repo-setup block wraps its work + broadcasts in a try/catch:
			// a throwing task_comments broadcast must be logged and swallowed, and the
			// wakeup still deferred with awaiting_repo_setup.
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string }) => {
						if (msg.table === 'task_comments')
							throw new Error('expected: comment broadcast failure');
					},
				} as unknown as JobManagerDeps['wsManager'],
			});
			await ctx.db.query('UPDATE member_agents SET touches_code = true WHERE id = $1', [agentId]);
			const savedRepo = await ctx.db.query<{ designated_repo_id: string | null }>(
				'SELECT designated_repo_id FROM projects WHERE id = $1',
				[projectId],
			);
			await ctx.db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [
				projectId,
			]);
			const wakeupId = await insertQueuedWakeup(agentId, 'timer', { task_id: taskId }, 'claimed');

			await (manager as unknown as JmInternals).activateAgent(
				agentId,
				teamId,
				wakeupId,
				{ task_id: taskId },
				'timer',
			);

			const r = await ctx.db.query<{ status: string; payload: Record<string, unknown> }>(
				'SELECT status, payload FROM agent_wakeup_requests WHERE id = $1',
				[wakeupId],
			);
			expect(r.rows[0].status).toBe(WakeupStatus.Deferred);
			expect(r.rows[0].payload.reason).toBe('awaiting_repo_setup');
			expect(r.rows[0].payload.project_id).toBe(projectId);

			await ctx.db.query('UPDATE projects SET designated_repo_id = $1 WHERE id = $2', [
				savedRepo.rows[0].designated_repo_id,
				projectId,
			]);
			await ctx.db.query('UPDATE member_agents SET touches_code = false WHERE id = $1', [agentId]);
			manager.shutdown();
		});
	});

	describe('completion bookkeeping double-failure', () => {
		it('logs and survives when onAgentComplete itself throws after a failed run', async () => {
			// runAgent throws (broken log broker) AND the completion bookkeeping
			// throws (member_agents broadcast fails on the idle flip). The launch
			// closure must swallow both and still release the dispatch guards.
			const throwingLogs = new LogStreamBroker();
			throwingLogs.begin = () => {
				throw new Error('expected: stream failure');
			};
			let memberAgentBroadcasts = 0;
			const manager = createJobManager({
				logs: throwingLogs,
				wsManager: {
					broadcast: (_room: string, msg: { table: string }) => {
						if (msg.table === 'member_agents' && ++memberAgentBroadcasts >= 2) {
							throw new Error('expected: idle broadcast failure');
						}
					},
				} as unknown as JobManagerDeps['wsManager'],
			});
			const wakeupId = await insertQueuedWakeup(agentId, 'mention', { task_id: taskId }, 'claimed');

			await (manager as unknown as JmInternals).activateAgent(
				agentId,
				teamId,
				wakeupId,
				{ task_id: taskId },
				'mention',
			);
			await waitForBackground();

			// The lock (released before the throwing broadcast) is freed and the
			// in-memory guards are back to empty despite the double failure.
			const locks = await ctx.db.query(
				'SELECT 1 FROM execution_locks WHERE task_id = $1 AND member_id = $2 AND released_at IS NULL',
				[taskId, agentId],
			);
			expect(locks.rows.length).toBe(0);
			expect(manager.isTaskRunning(`${agentId}:${projectId}`)).toBe(false);
			expect(internals(manager).activeTaskRuns.has(taskId)).toBe(false);
			expect(internals(manager).activeProjectRuns.has(projectId)).toBe(false);
			manager.shutdown();
		});
	});

	describe('postFailurePing edge cases', () => {
		it('posts nothing when the run row does not exist', async () => {
			const manager = createJobManager();
			await (manager as unknown as JmInternals).onAgentComplete(
				agentId,
				'engineer',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{
					success: false,
					exitCode: -1,
					stdout: '',
					stderr: 'gone',
					heartbeatRunId: '00000000-0000-0000-0000-0000000000bb',
				},
			);
			const pings = await ctx.db.query(
				`SELECT 1 FROM task_comments WHERE task_id = $1 AND content->>'kind' = 'run_failed'`,
				[taskId],
			);
			expect(pings.rows.length).toBe(0);
			manager.shutdown();
		});

		it('posts a ping with a null error when the failed run recorded none', async () => {
			const manager = createJobManager();
			const run = await ctx.db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, error, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, NULL, now())
				 RETURNING id`,
				[agentId, teamId, taskId, HeartbeatRunStatus.Failed],
			);

			await (manager as unknown as JmInternals).onAgentComplete(
				agentId,
				'engineer',
				taskId,
				taskIdentifier,
				teamId,
				undefined,
				undefined,
				{
					success: false,
					exitCode: 1,
					stdout: '',
					stderr: '',
					heartbeatRunId: run.rows[0].id,
				},
			);

			const ping = await ctx.db.query<{ content: { error: string | null } }>(
				`SELECT content FROM task_comments
				 WHERE task_id = $1 AND content->>'kind' = 'run_failed'`,
				[taskId],
			);
			expect(ping.rows.length).toBe(1);
			expect(ping.rows[0].content.error).toBeNull();
			manager.shutdown();
		});
	});

	describe('wakeup-creation failures in completion follow-ups', () => {
		it('declines the timeout continuation when its wakeup insert fails and falls back to the ping', async () => {
			const manager = createJobManager();
			const run = await ctx.db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())
				 RETURNING id`,
				[agentId, teamId, taskId, HeartbeatRunStatus.TimedOut],
			);
			// A team id that satisfies the uuid type but violates the FK: the
			// continuation's createWakeup throws and the catch declines the queue.
			const bogusTeamId = '00000000-0000-0000-0000-0000000000dd';

			await (manager as unknown as JmInternals).onAgentComplete(
				agentId,
				'engineer',
				taskId,
				taskIdentifier,
				bogusTeamId,
				undefined,
				undefined,
				{
					success: false,
					exitCode: -1,
					stdout: '',
					stderr: 'timed out',
					heartbeatRunId: run.rows[0].id,
					timedOut: true,
				},
			);

			const continuation = await ctx.db.query(
				`SELECT 1 FROM agent_wakeup_requests
				 WHERE member_id = $1 AND payload->>'reason' = 'timeout_continuation'`,
				[agentId],
			);
			expect(continuation.rows.length).toBe(0);
			// The declined continuation fell through to the failure ping.
			const ping = await ctx.db.query(
				`SELECT 1 FROM task_comments WHERE task_id = $1 AND content->>'kind' = 'run_failed'`,
				[taskId],
			);
			expect(ping.rows.length).toBe(1);
			manager.shutdown();
		});
	});

	describe('chainNextTaskWakeup for instance agents', () => {
		it('chains the CEO across teams to its next assigned open task', async () => {
			const manager = createJobManager();
			const ceo = await ctx.db.query<{ id: string; team_id: string }>(
				`SELECT ma.id, m.team_id FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE ma.slug = $1 LIMIT 1`,
				[CEO_AGENT_SLUG],
			);
			const ceoId = ceo.rows[0].id;
			const hqTeamId = ceo.rows[0].team_id;

			// Park any pre-existing CEO tasks (coherence passes etc.) so the chain
			// target is unambiguous.
			await ctx.db.query(`UPDATE tasks SET status = $1::task_status WHERE assignee_id = $2`, [
				TaskStatus.Done,
				ceoId,
			]);
			const taskRes = await ctx.app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(ctx.token), ...json },
				body: JSON.stringify({
					project_id: projectId,
					title: 'CEO cross-team chain target',
					assignee_id: ceoId,
				}),
			});
			const ceoTaskId = (await taskRes.json()).data.id as string;
			await waitForBackground();
			await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [ceoId]);

			// Complete an unrelated task as the CEO: the chain must pick the CEO's
			// open task in the *project* team even though the CEO lives in HQ.
			await (manager as unknown as JmInternals).onAgentComplete(
				ceoId,
				CEO_AGENT_SLUG,
				taskId,
				taskIdentifier,
				hqTeamId,
				undefined,
				undefined,
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			const chain = await ctx.db.query<{ payload: Record<string, unknown> }>(
				`SELECT payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND source = 'timer'::wakeup_source`,
				[ceoId],
			);
			expect(chain.rows.length).toBe(1);
			expect(chain.rows[0].payload.task_id).toBe(ceoTaskId);
			expect(chain.rows[0].payload.reason).toBe('chain_after_completion');

			await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [ceoId]);
			await ctx.db.query('DELETE FROM tasks WHERE id = $1', [ceoTaskId]);
			manager.shutdown();
		});

		it('logs and continues when the chain wakeup insert fails', async () => {
			const manager = createJobManager();
			const ceo = await ctx.db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma WHERE ma.slug = $1 LIMIT 1`,
				[CEO_AGENT_SLUG],
			);
			const ceoId = ceo.rows[0].id;
			const taskRes = await ctx.app.request(`/api/projects/${projectSlug}/tasks`, {
				method: 'POST',
				headers: { ...authHeader(ctx.token), ...json },
				body: JSON.stringify({
					project_id: projectId,
					title: 'CEO chain-failure target',
					assignee_id: ceoId,
				}),
			});
			const ceoTaskId = (await taskRes.json()).data.id as string;
			await waitForBackground();
			await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [ceoId]);

			// Instance agents ignore the team scope when selecting the next task, so
			// the chain still finds one — but createWakeup then hits the FK on the
			// bogus team id and the catch swallows it.
			await (manager as unknown as JmInternals).onAgentComplete(
				ceoId,
				CEO_AGENT_SLUG,
				taskId,
				taskIdentifier,
				'00000000-0000-0000-0000-0000000000ee',
				undefined,
				undefined,
				{ success: true, exitCode: 0, stdout: '', stderr: '' },
			);

			const wakeups = await ctx.db.query(
				'SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1',
				[ceoId],
			);
			expect(wakeups.rows.length).toBe(0);

			await ctx.db.query('DELETE FROM tasks WHERE id = $1', [ceoTaskId]);
			manager.shutdown();
		});
	});

	describe('launchTask timeout', () => {
		it('aborts a run with the tagged run_timeout reason when the wall clock expires', async () => {
			const manager = createJobManager();
			let reason: unknown;
			manager.launchTask(
				'timeout:probe',
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => {
							reason = signal.reason;
							resolve();
						});
					}),
				25,
			);
			await new Promise((r) => setTimeout(r, 120));
			expect(reason).toBe('run_timeout');
			expect(manager.isTaskRunning('timeout:probe')).toBe(false);
			manager.shutdown();
		});
	});

	describe('start() cron registration', () => {
		it('registers the optional pricing and telemetry crons and is idempotent', () => {
			const manager = createJobManager({
				pricing: { refresh: async () => 0 } as unknown as PricingService,
				telemetry: { enabled: true, endpoint: 'http://127.0.0.1:1/unused' },
			});
			const spy = vi.spyOn(internals(manager).cron, 'createJob');
			manager.start();
			const names = spy.mock.calls.map((c) => c[0]);
			expect(names).toEqual(
				expect.arrayContaining([
					'wakeups',
					'heartbeats',
					'orphan-detection',
					'container-sync',
					'inbox-archive',
					'budget-resume',
					'update-check',
					'pricing-refresh',
					'telemetry',
				]),
			);
			const count = spy.mock.calls.length;
			manager.start();
			expect(spy.mock.calls.length).toBe(count);
			manager.shutdown();
		});
	});
});

/**
 * The `connector-health` cron. Its substantive bounds (limit, soonest-first
 * ordering, concurrency) are covered against `refreshExpiringTokens` itself in
 * `oauth-token-resolver.test.ts`; what belongs here is the wrapper's own guard.
 */
describe('connector-health sweep', () => {
	it('does nothing while the vault is locked', async () => {
		// Every candidate would otherwise fail to decrypt its refresh token and log
		// a warning - once per connection, every five minutes, for as long as the
		// instance stays locked.
		let refreshed = 0;
		const conn = await ctx.db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value) VALUES ('SWEEP_LOCKED_TOK', 'enc') RETURNING id`,
		);
		await ctx.db.query(
			`INSERT INTO oauth_connections
			   (provider, provider_account_id, provider_account_label,
			    access_token_secret_id, refresh_token_secret_id, expires_at)
			 VALUES ('sweep-locked', 'acct', 'Locked', $1, $1, now() - interval '1 hour')`,
			[conn.rows[0].id],
		);
		registerRefreshFn('sweep-locked', async () => {
			refreshed++;
			return { accessToken: 'new' };
		});

		try {
			const manager = createJobManager({
				masterKeyManager: {
					getKey: () => null,
				} as unknown as JobManagerDeps['masterKeyManager'],
			});
			await internals(manager).sweepConnectorHealth();
			expect(refreshed).toBe(0);
		} finally {
			clearRefreshFns();
		}
	});
});
