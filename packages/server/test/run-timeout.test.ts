import {
	ContainerStatus,
	HeartbeatRunStatus,
	RunCancelReason,
	WakeupSkipReason,
	WakeupSource,
	WakeupStatus,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { type RunnerDeps, runAgent } from '../src/services/agent-runner';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
	stubEngineSeams,
} from './helpers/app';
import { withRunUserStub } from './helpers/run-user-docker';

// Part 2 of the run-limit work: a run cut off by its wall-clock time limit finalizes as
// `timed_out` (distinct from a user cancel) and auto-queues a same-task continuation, with a
// loop cap. The launchTask timer can't be waited on (60 min), so the classifier tests abort
// the run's signal mid-exec, and the continuation/cap tests drive the private JobManager
// methods directly (the pattern used across job-manager-workflows.test.ts).

// The runner's data dir must be the harness's own, not a fixed path: the
// container engine resolves a run's files through the project's workspace under
// it, so a hardcoded literal would stage them somewhere the test cannot read.
let testDataDir: string;
let app: Hono<Env>;
let db: Db;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let taskIdentifier: string;
let agentId: string;

const originalFetch = globalThis.fetch;

function createMockDocker(overrides: Record<string, any> = {}): ContainerEngine {
	const { execStart: execStartOverride, ...rest } = overrides;
	// Built on createStubDocker rather than hand-rolled: a literal cast through
	// `as unknown as ContainerEngine` silently omits whatever the interface grows
	// next, and the compiler cannot say so. That is how six specs came to call a
	// method that did not exist on their engine.
	const base = createStubDocker({
		ping: async () => true,
		imageExists: async () => true,
		pullImage: async () => {},
		createContainer: async () => ({ Id: 'container-123', Warnings: [] }),
		startContainer: async () => {},
		stopContainer: async () => {},
		removeContainer: async () => {},
		inspectContainer: async () => ({
			Id: 'container-123',
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'test' },
		}),
		containerLogs: async () => new ReadableStream(),
		execCreate: async () => 'exec-123',
		...stubEngineSeams(),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
		killRunProcesses: async () => {},
		execStart: execStartOverride ?? (async () => ({ stdout: 'done', stderr: '' })),
		...rest,
		// The run stages its prompt and runtime home through the engine seam, so an
		// inline engine needs the same bind-resolving view the shared stub gives.
		files: createStubDocker().files,
	});
	// Transparently answer the run-user probe so those infra execs don't hit execStart.
	return withRunUserStub(base);
}

function makeDeps(dockerOverrides: Record<string, any> = {}): RunnerDeps {
	const wsManager = {
		broadcast: () => {},
		subscribe: () => {},
		unsubscribe: () => {},
		unsubscribeAll: () => {},
		getRoomSize: () => 0,
		getTotalConnections: () => 0,
	} as any;
	const logs = new LogStreamBroker();
	logs.setWsManager(wsManager);
	return {
		db,
		docker: createMockDocker(dockerOverrides),
		masterKeyManager,
		serverPort: 3000,
		dataDir: testDataDir,
		wsManager,
		logs,
	};
}

function createJobManager(): JobManager {
	return new JobManager({
		db,
		docker: createMockDocker(),
		masterKeyManager,
		serverPort: 3100,
		dataDir: testDataDir,
		wsManager: { broadcast: () => {} } as any,
		logs: new LogStreamBroker(),
		containerLogStreamer: new ContainerLogStreamer(),
	});
}

// No designated repo → runAgent skips worktree prep and goes straight to exec.
function makeAgent() {
	return { id: agentId, title: 'Test Agent', team_id: teamId };
}
function makeTask() {
	return {
		id: taskId,
		identifier: taskIdentifier,
		title: 'Timeout Task',
		description: 'desc',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
	};
}
function makeProject() {
	return {
		id: projectId,
		slug: projectSlug,
		team_id: teamId,
		team_slug: 'timeout-co',
		container_id: 'container-123',
		container_status: ContainerStatus.Running,
		designated_repo_id: null,
		is_internal: false,
	};
}

beforeAll(async () => {
	const ctx = await createTestApp();
	testDataDir = ctx.dataDir;
	app = ctx.app;
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;
	const adminToken = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, { name: 'Timeout Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	// An AI provider so runAgent can resolve credentials before it reaches exec.
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ provider: 'anthropic', api_key: 'sk-ant-test', label: 'anthropic' }),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Timeout Project',
		description: 'p',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Timeout Task',
			description: 'd',
			assignee_id: agentId,
		}),
	});
	const createdTask = (await taskRes.json()).data;
	taskId = createdTask.id;
	taskIdentifier = createdTask.identifier;
});

afterAll(async () => {
	await waitForBackground();
	await safeClose(db);
});

// Reset the per-task run/wakeup history so each continuation test is isolated.
async function resetTaskHistory() {
	await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [agentId]);
	await db.query('DELETE FROM heartbeat_runs WHERE task_id = $1', [taskId]);
}

describe('run timeout classification (runAgent)', () => {
	it('finalizes a run aborted for run_timeout as timed_out and flags result.timedOut', async () => {
		const ac = new AbortController();
		const deps = makeDeps({
			execStart: async () => {
				ac.abort('run_timeout');
				throw new DOMException('Aborted', 'AbortError');
			},
		});

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.timedOut).toBe(true);
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.TimedOut);
	});

	it('finalizes a bare abort (user cancel) as cancelled, not timed_out', async () => {
		const ac = new AbortController();
		const deps = makeDeps({
			execStart: async () => {
				ac.abort(); // no reason → user-cancel semantics
				throw new DOMException('Aborted', 'AbortError');
			},
		});

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.timedOut).toBeFalsy();
		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);
	});
});

describe('timeout continuation (JobManager)', () => {
	it('queues a same-task timeout_continuation wakeup when under the cap', async () => {
		await resetTaskHistory();
		const manager = createJobManager();

		const queued = await (manager as any).queueTimeoutContinuation(agentId, taskId, teamId);

		expect(queued).toBe(true);
		const w = await db.query<{ source: string; payload: { reason?: string; task_id?: string } }>(
			`SELECT source, payload FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued'`,
			[agentId],
		);
		expect(w.rows.length).toBe(1);
		expect(w.rows[0].source).toBe(WakeupSource.Timer);
		expect(w.rows[0].payload.reason).toBe('timeout_continuation');
		expect(w.rows[0].payload.task_id).toBe(taskId);
	});

	it('declines to queue after MAX consecutive timeouts (loop cap)', async () => {
		await resetTaskHistory();
		// Seed 5 consecutive timed_out runs (matches MAX_CONSECUTIVE_TIMEOUT_CONTINUATIONS).
		for (let i = 0; i < 5; i++) {
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, 'timed_out', now() - make_interval(secs => $4))`,
				[teamId, agentId, taskId, (5 - i) * 10],
			);
		}
		const manager = createJobManager();

		const queued = await (manager as any).queueTimeoutContinuation(agentId, taskId, teamId);

		expect(queued).toBe(false);
		const w = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued'`,
			[agentId],
		);
		expect(w.rows.length).toBe(0);
	});

	it('still queues when the timeout streak is broken by a non-timeout run', async () => {
		await resetTaskHistory();
		// 4 timeouts then a most-recent succeeded run → streak broken → not at cap.
		for (let i = 0; i < 4; i++) {
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, 'timed_out', now() - make_interval(secs => $4))`,
				[teamId, agentId, taskId, 100 + (4 - i) * 10],
			);
		}
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'succeeded', now())`,
			[teamId, agentId, taskId],
		);
		const manager = createJobManager();

		const queued = await (manager as any).queueTimeoutContinuation(agentId, taskId, teamId);

		expect(queued).toBe(true);
	});

	it('onAgentComplete on a timed-out run queues a continuation and posts no failure ping', async () => {
		await resetTaskHistory();
		const runRow = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'timed_out', now()) RETURNING id`,
			[teamId, agentId, taskId],
		);
		const manager = createJobManager();

		await (manager as any).onAgentComplete(
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
				stderr: 'run reached its time limit',
				durationMs: 1,
				heartbeatRunId: runRow.rows[0].id,
				timedOut: true,
			},
		);

		const w = await db.query(
			`SELECT 1 FROM agent_wakeup_requests WHERE member_id = $1 AND status = 'queued'`,
			[agentId],
		);
		expect(w.rows.length).toBe(1); // the continuation (chainNextTaskWakeup is skipped on timeout)

		const failed = await db.query(
			`SELECT 1 FROM task_comments WHERE task_id = $1 AND content->>'kind' = 'run_failed'`,
			[taskId],
		);
		expect(failed.rows.length).toBe(0); // failure ping suppressed for a continuing timeout
	});
});

/**
 * Shutdown is the one abort reason that hands the work back instead of ending the
 * run, and it has to, because nothing downstream can do it afterwards.
 *
 * The drain finalizes the run row and settles its wakeup before the process
 * exits, and every recovery predicate in the codebase - `reconcileDatabaseOnStartup`,
 * `detectOrphanedRuns`, `healStaleRunState`, `requeueContainerKilledRuns` - looks
 * for a row left `running` or `queued`. So an orderly shutdown dropped the work
 * outright while a hard crash recovered: the better the shutdown behaved, the more
 * certainly the task stopped. The row's own message promised a re-queue that no
 * code delivered.
 */
describe('shutdown handback (runAgent + JobManager)', () => {
	it('finalizes a shutdown-aborted run as cancelled and asks for a re-queue', async () => {
		const ac = new AbortController();
		const deps = makeDeps({
			execStart: async () => {
				ac.abort('server_shutdown');
				throw new DOMException('Aborted', 'AbortError');
			},
		});

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.requeued).toBe(true);
		expect(result.requeueReason).toBe(WakeupSkipReason.ServerShutdown);

		const run = await db.query<{ status: string; error: string }>(
			'SELECT status, error FROM heartbeat_runs WHERE id = $1',
			[result.heartbeatRunId],
		);
		// `cancelled`, not `failed`. A shutdown is not a verdict on the agent, and a
		// terminal `failed` row is precisely what boot recovery cannot match.
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Cancelled);
		expect(run.rows[0].error).toContain('Server shut down while this run was in flight');
		expect(run.rows[0].error).toContain('returning this run to the queue');
	});

	it('hands back a run the drain caught before it had a row at all', async () => {
		// The earliest landing point, and the one with no row to hand back through:
		// the drain can abort between the dispatch and the run's first write. The
		// work is owed exactly as much as it is mid-exec, so the flag alone carries
		// it - there is simply nothing to annotate.
		const ac = new AbortController();
		ac.abort('server_shutdown');

		const result = await runAgent(
			makeDeps(),
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.requeued).toBe(true);
		expect(result.requeueReason).toBe(WakeupSkipReason.ServerShutdown);
		// No run row, deliberately: none was ever created, so none is invented.
		expect(result.heartbeatRunId).toBeUndefined();
	});

	it('hands back a run the drain caught between phases', async () => {
		// The third landing point: `finalizeAbort`, reached at a phase checkpoint
		// rather than on the exec rejection. Aborting while the container is being
		// acquired puts the run on the checkpoint before it is marked running.
		//
		// Every rung of the acquire ladder aborts, not just the provision one: which
		// rung this takes depends on whether a sibling case left a warm container on
		// the shared project, so hooking only `startContainer` passed alone and
		// failed in a full run.
		const ac = new AbortController();
		const shutdown = () => ac.abort('server_shutdown');
		const deps = makeDeps({
			startContainer: async () => {
				shutdown();
			},
			createContainer: async () => {
				shutdown();
				return { Id: 'container-123', Warnings: [] };
			},
			inspectContainer: async () => {
				shutdown();
				return {
					Id: 'container-123',
					State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
					Config: { Image: 'test' },
				};
			},
		});

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.requeued).toBe(true);
		expect(result.requeueReason).toBe(WakeupSkipReason.ServerShutdown);
	});

	it('hands back a shutdown that lands in the setup window', async () => {
		// The fourth landing point: after the container is acquired and before the
		// exec, where the credential lock, the tunnel and `buildRunContext` run. A
		// throw there with the signal already aborted is the shape the drain makes
		// at that moment, and it has its own branch because the exec catch is not
		// reached from here at all.
		const ac = new AbortController();
		const deps = makeDeps({
			openExecChannel: async () => {
				ac.abort('server_shutdown');
				throw new Error('tunnel torn down by shutdown');
			},
		});

		const result = await runAgent(
			deps,
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.requeued).toBe(true);
		expect(result.requeueReason).toBe(WakeupSkipReason.ServerShutdown);
	});

	it('still fails a bare pre-run abort rather than re-queueing it', async () => {
		// A user cancel arriving in the same window is a decision to stop, not work
		// owed - so the handback must be reasoned from the reason, not from the fact
		// that the signal was already aborted.
		const ac = new AbortController();
		ac.abort();

		const result = await runAgent(
			makeDeps(),
			makeAgent(),
			makeTask(),
			makeProject(),
			undefined,
			ac.signal,
		);

		expect(result.requeued).toBeFalsy();
	});

	it('returns the wakeup to the queue, which is the promise the message makes', async () => {
		await resetTaskHistory();
		// The wakeup this run was dispatched for, claimed as a live dispatch leaves it.
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, $3::wakeup_source, 'claimed', $4::jsonb) RETURNING id`,
			[agentId, teamId, WakeupSource.Timer, JSON.stringify({ task_id: taskId })],
		);
		const runRow = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'cancelled', now()) RETURNING id`,
			[teamId, agentId, taskId],
		);
		const manager = createJobManager();

		await (manager as any).onAgentComplete(
			agentId,
			'engineer',
			taskId,
			taskIdentifier,
			teamId,
			wakeup.rows[0].id,
			undefined,
			{
				success: false,
				exitCode: -1,
				stdout: '',
				stderr: 'Server shut down while this run was in flight',
				durationMs: 1,
				heartbeatRunId: runRow.rows[0].id,
				requeued: true,
				requeueReason: WakeupSkipReason.ServerShutdown,
			},
		);

		const w = await db.query<{ status: string }>(
			'SELECT status FROM agent_wakeup_requests WHERE id = $1',
			[wakeup.rows[0].id],
		);
		// Queued, so the 5s cron picks it up when the process is next up. This is the
		// half that was missing: the drain settled it `failed` and it stayed there.
		expect(w.rows[0].status).toBe(WakeupStatus.Queued);

		const row = await db.query<{ cancel_reason: string | null }>(
			'SELECT cancel_reason FROM heartbeat_runs WHERE id = $1',
			[runRow.rows[0].id],
		);
		// Recorded only once the handback is known to have landed, and it is what
		// keeps a dead Retry button off a run whose work is already carried.
		expect(row.rows[0].cancel_reason).toBe(RunCancelReason.HandedBack);
	});
});
