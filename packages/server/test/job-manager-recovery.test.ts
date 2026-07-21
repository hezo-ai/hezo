import { createServer, type Server } from 'node:http';
import {
	AgentRuntimeStatus,
	ContainerStatus,
	HeartbeatRunStatus,
	WakeupStatus,
} from '@hezo/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { ContainerLogStreamer } from '../src/services/container-logs';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { PricingService } from '../src/services/pricing';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// Startup reconciliation and the periodic maintenance sweeps of JobManager:
// stranded-run recovery (incl. partial-usage cost charging), the three startup
// container passes (restart, stale-mount repair, self-heal), the HQ warm-up,
// stale-dispatch reaping, container status sync + failure transitions, inbox
// archiving, and the small maintenance jobs (update check, pricing refresh,
// telemetry).

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;

const json = { 'Content-Type': 'application/json' };

interface JmInternals {
	repairStaleContainerMounts(docker: unknown): Promise<void>;
	selfHealErroredContainers(docker: unknown): Promise<void>;
	restartStoppedRunningContainers(docker: unknown): Promise<void>;
	sweepStaleDispatches(): Promise<void>;
	detectOrphanedRuns(): Promise<void>;
	syncContainerStatuses(): Promise<void>;
	archiveInboxItems(): Promise<void>;
	checkForUpdate(): Promise<void>;
	refreshPricing(): Promise<void>;
	runTelemetry(): Promise<void>;
	guarded(name: string, fn: () => Promise<void>): Promise<void>;
	activeTaskRuns: Set<string>;
	activeProjectRuns: Map<string, number>;
	deps: JobManagerDeps;
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

// Exec stubs that keep the post-restart /workspace probe (and any bring-up
// execs) succeeding so container passes don't cascade into rebuilds.
const happyExec = {
	execCreate: async () => 'exec-ok',
	execStart: async () => ({ stdout: 'ok', stderr: '' }),
	execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
};

beforeAll(async () => {
	ctx = await createTestContext();
	const { app, db, token } = ctx;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Recovery JM Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Recovery JM Project',
		description: 'Recovery coverage project.',
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

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), ...json },
		body: JSON.stringify({ project_id: projectId, title: 'Recovery Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;

	await waitForBackground();
	await db.query("DELETE FROM agent_wakeup_requests WHERE payload->>'task_id' = $1::text", [
		taskId,
	]);
});

afterEach(async () => {
	await waitForBackground();
	await ctx.db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
	await ctx.db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');
	await ctx.db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
});

afterAll(async () => {
	await destroyTestContext(ctx);
});

describe('JobManager recovery & maintenance', () => {
	describe('reconcileOnStartup', () => {
		it('fails running and queued stranded runs, resets agents, releases locks, queues recovery', async () => {
			const { db } = ctx;
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Running],
			);
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status)`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Queued],
			);
			await db.query(
				'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
				[AgentRuntimeStatus.Active, agentId],
			);
			await db.query('INSERT INTO execution_locks (task_id, member_id) VALUES ($1, $2)', [
				taskId,
				agentId,
			]);

			const broadcasts: Array<{ table: string }> = [];
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string }) => broadcasts.push(msg),
				} as unknown as JobManagerDeps['wsManager'],
			});
			await manager.reconcileOnStartup();

			const runs = await db.query<{ status: string; error: string; exit_code: number }>(
				'SELECT status::text AS status, error, exit_code FROM heartbeat_runs WHERE team_id = $1',
				[teamId],
			);
			expect(runs.rows.length).toBe(2);
			for (const run of runs.rows) {
				expect(run.status).toBe(HeartbeatRunStatus.Failed);
				expect(run.error).toContain('Server restarted');
				expect(run.exit_code).toBe(-1);
			}

			const agent = await db.query<{ runtime_status: string }>(
				'SELECT runtime_status FROM member_agents WHERE id = $1',
				[agentId],
			);
			expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);

			const locks = await db.query('SELECT 1 FROM execution_locks WHERE released_at IS NULL');
			expect(locks.rows.length).toBe(0);

			const recovery = await db.query<{ payload: Record<string, unknown> }>(
				`SELECT payload FROM agent_wakeup_requests
				 WHERE member_id = $1 AND status = $2::wakeup_status`,
				[agentId, WakeupStatus.Queued],
			);
			expect(recovery.rows.some((r) => r.payload.reason === 'startup_recovery')).toBe(true);

			expect(broadcasts.some((b) => b.table === 'heartbeat_runs')).toBe(true);
			expect(broadcasts.some((b) => b.table === 'member_agents')).toBe(true);
			manager.shutdown();
		});

		it('charges a stranded run’s surviving partial usage to cost_entries', async () => {
			const { db } = ctx;
			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
			const inserted = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs
				   (team_id, member_id, task_id, status, started_at, input_tokens, output_tokens, cost_cents, usage_partial)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now(), 2000, 400, 53, true)
				 RETURNING id`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Running],
			);
			const runId = inserted.rows[0].id;

			const manager = createJobManager();
			await manager.reconcileOnStartup();

			const run = await db.query<{ status: string; input_tokens: number; cost_cents: number }>(
				'SELECT status::text AS status, input_tokens, cost_cents FROM heartbeat_runs WHERE id = $1',
				[runId],
			);
			expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			expect(Number(run.rows[0].input_tokens)).toBe(2000);
			expect(Number(run.rows[0].cost_cents)).toBe(53);

			const cost = await db.query<{ amount_cents: number }>(
				'SELECT amount_cents FROM cost_entries WHERE member_id = $1 AND description = $2',
				[agentId, `Agent run ${runId}`],
			);
			expect(cost.rows.length).toBe(1);
			expect(Number(cost.rows[0].amount_cents)).toBe(53);

			await db.query('DELETE FROM cost_entries WHERE member_id = $1', [agentId]);
			manager.shutdown();
		});

		it('parks repos stranded pending by a restart as failed and broadcasts them', async () => {
			const { db } = ctx;
			const inserted = await db.query<{ id: string }>(
				`INSERT INTO repos (project_id, repo_identifier, host_type, setup_status)
				 VALUES ($1, 'acme/stranded', 'github', 'pending'::repo_setup_status)
				 RETURNING id`,
				[projectId],
			);

			const broadcasts: Array<{ table: string; row: Record<string, unknown> }> = [];
			const manager = createJobManager({
				wsManager: {
					broadcast: (_room: string, msg: { table: string; row: Record<string, unknown> }) =>
						broadcasts.push(msg),
				} as unknown as JobManagerDeps['wsManager'],
			});
			await manager.reconcileOnStartup();

			const repo = await db.query<{ setup_status: string; setup_error: string | null }>(
				'SELECT setup_status::text AS setup_status, setup_error FROM repos WHERE id = $1',
				[inserted.rows[0].id],
			);
			expect(repo.rows[0].setup_status).toBe('failed');
			expect(repo.rows[0].setup_error).toContain('Server restarted');
			const b = broadcasts.find((x) => x.table === 'repos' && x.row.id === inserted.rows[0].id);
			expect(b?.row.setup_status).toBe('failed');

			manager.shutdown();
			await db.query('DELETE FROM repos WHERE id = $1', [inserted.rows[0].id]);
		});
	});

	describe('startup container passes', () => {
		beforeEach(async () => {
			await ctx.db.query(
				'UPDATE projects SET container_status = NULL, container_id = NULL, container_error = NULL',
			);
		});
		afterEach(async () => {
			await ctx.db.query(
				'UPDATE projects SET container_status = NULL, container_id = NULL, container_error = NULL',
			);
		});

		it('restarts an exited container and wakes agents with pending work', async () => {
			const { db } = ctx;
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status,
				        container_id = 'exited-box', container_error = 'old error'
				 WHERE id = $1`,
				[projectId],
			);

			const startCalls: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					...happyExec,
					inspectContainer: async (id: string) => ({
						Id: id,
						State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
						Config: { Image: 'stub' },
					}),
					startContainer: async (id: string) => {
						startCalls.push(id);
					},
				}),
			});

			await manager.reconcileOnStartup();
			await waitForBackground();

			expect(startCalls).toEqual(['exited-box']);
			const row = await db.query<{ container_error: string | null }>(
				'SELECT container_error FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_error).toBeNull();

			// The restart woke the agent with an open assigned task.
			const wakeups = await db.query<{ payload: Record<string, unknown> }>(
				'SELECT payload FROM agent_wakeup_requests WHERE member_id = $1',
				[agentId],
			);
			expect(wakeups.rows.some((w) => w.payload.trigger === 'container_start')).toBe(true);
			manager.shutdown();
		});

		it('re-provisions a container that vanished from Docker', async () => {
			const { db } = ctx;
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status, container_id = 'vanished'
				 WHERE id = $1`,
				[projectId],
			);

			const createCalls: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					...happyExec,
					inspectContainer: async () => null,
					createContainer: async (name: string) => {
						createCalls.push(name);
						return { Id: 'fresh-box', Warnings: [] };
					},
				}),
			});

			await manager.reconcileOnStartup();
			await waitForBackground();

			expect(
				createCalls.some((n) => n.startsWith(`hezo-${projectSlug}-${projectId.slice(0, 8)}`)),
			).toBe(true);
			const row = await db.query<{ container_id: string | null; container_status: string }>(
				'SELECT container_id, container_status::text AS container_status FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_id).toBe('fresh-box');
			expect(row.rows[0].container_status).toBe(ContainerStatus.Running);
			manager.shutdown();
		});

		it('logs and continues when restarting a container throws', async () => {
			const { db } = ctx;
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status,
				        container_id = 'wedged-box', container_error = 'old error'
				 WHERE id = $1`,
				[projectId],
			);

			const startAttempts: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					...happyExec,
					inspectContainer: async (id: string) => ({
						Id: id,
						State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
						Config: { Image: 'stub' },
					}),
					startContainer: async (id: string) => {
						startAttempts.push(id);
						throw new Error('expected: docker start failure');
					},
				}),
			});

			// The restart pass must not throw; the failed row's state stays untouched.
			await (manager as unknown as JmInternals).restartStoppedRunningContainers(
				internals(manager).deps.docker,
			);
			expect(startAttempts).toEqual(['wedged-box']);
			const row = await db.query<{ container_error: string | null }>(
				'SELECT container_error FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_error).toBe('old error');
			manager.shutdown();
		});

		it('skips restart, self-heal, and HQ warm-up when Docker is unreachable', async () => {
			const { db } = ctx;
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status, container_id = 'unreached'
				 WHERE id = $1`,
				[projectId],
			);
			const inspectCalls: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					// The mount-repair pass is not ping-gated, so keep its probe green;
					// the ping-gated passes must never reach inspectContainer.
					...happyExec,
					ping: async () => false,
					inspectContainer: async (id: string) => {
						inspectCalls.push(id);
						return null;
					},
				}),
			});

			await manager.reconcileOnStartup();
			await manager.ensureHqContainerRunning();

			expect(inspectCalls).toEqual([]);
			const row = await db.query<{ container_id: string | null }>(
				'SELECT container_id FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_id).toBe('unreached');
			manager.shutdown();
		});

		it('rebuilds a running container whose /workspace probe fails', async () => {
			const { db } = ctx;
			// No designated repo → the rebuild bring-up has nothing to clone.
			await db.query('UPDATE projects SET designated_repo_id = NULL WHERE id = $1', [projectId]);
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status, container_id = 'stale-box'
				 WHERE id = $1`,
				[projectId],
			);

			let probeExecId = '';
			let rebuilt = false;
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
				}),
			});

			await (manager as unknown as JmInternals).repairStaleContainerMounts(
				internals(manager).deps.docker,
			);
			await waitForBackground();

			expect(rebuilt).toBe(true);
			const row = await db.query<{ container_id: string | null }>(
				'SELECT container_id FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_id).toBe('rebuilt-box');
			manager.shutdown();
		});

		it('logs and continues when the stale-mount rebuild itself fails', async () => {
			const { db } = ctx;
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status, container_id = 'stale-box2'
				 WHERE id = $1`,
				[projectId],
			);

			const manager = createJobManager({
				docker: createStubDocker({
					// Every probe exec fails (mount unreachable)…
					execCreate: async () => 'probe-exec',
					execStart: async () => ({ stdout: '', stderr: '' }),
					execInspect: async () => ({ ExitCode: 1, Running: false, Pid: 0 }),
					// …and the rebuild blows up.
					createContainer: async () => {
						throw new Error('expected: rebuild failure');
					},
				}),
			});

			await expect(
				(manager as unknown as JmInternals).repairStaleContainerMounts(
					internals(manager).deps.docker,
				),
			).resolves.toBeUndefined();
			manager.shutdown();
		});

		it('self-heals an errored project by re-attaching to a live container', async () => {
			const { db } = ctx;
			await db.query(
				`UPDATE projects SET container_status = 'error'::container_status, container_id = NULL
				 WHERE id = $1`,
				[projectId],
			);
			const expectedPrefix = `hezo-${projectSlug}-${projectId.slice(0, 8)}`;

			const manager = createJobManager({
				docker: createStubDocker({
					...happyExec,
					findContainerByNamePrefix: async (name: string) =>
						name.startsWith(expectedPrefix)
							? {
									Id: 'live-box',
									Names: [`/${name}`],
									State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
									Config: { Image: 'stub' },
								}
							: null,
				}),
			});

			await (manager as unknown as JmInternals).selfHealErroredContainers(
				internals(manager).deps.docker,
			);

			const row = await db.query<{ container_id: string | null; container_status: string }>(
				'SELECT container_id, container_status::text AS container_status FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_id).toBe('live-box');
			expect(row.rows[0].container_status).toBe(ContainerStatus.Running);
			manager.shutdown();
		});

		it('self-heal skips a project whose inspect throws and one whose container is not running', async () => {
			const { db } = ctx;
			await db.query(
				`UPDATE projects SET container_status = 'error'::container_status, container_id = NULL
				 WHERE id = $1`,
				[projectId],
			);
			const expectedPrefix = `hezo-${projectSlug}-${projectId.slice(0, 8)}`;

			// First pass: the inspect throws for our project — self-heal warns and skips.
			const throwing = createJobManager({
				docker: createStubDocker({
					...happyExec,
					findContainerByNamePrefix: async (name: string) => {
						if (name.startsWith(expectedPrefix)) throw new Error('expected: inspect failure');
						return null;
					},
				}),
			});
			await (throwing as unknown as JmInternals).selfHealErroredContainers(
				internals(throwing).deps.docker,
			);
			let row = await db.query<{ container_status: string }>(
				'SELECT container_status::text AS container_status FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_status).toBe(ContainerStatus.Error);
			throwing.shutdown();

			// Second pass: the container exists but is not running — also skipped.
			const stopped = createJobManager({
				docker: createStubDocker({
					...happyExec,
					findContainerByNamePrefix: async (name: string) =>
						name.startsWith(expectedPrefix)
							? {
									Id: 'dead-box',
									Names: [`/${name}`],
									State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 1 },
									Config: { Image: 'stub' },
								}
							: null,
				}),
			});
			await (stopped as unknown as JmInternals).selfHealErroredContainers(
				internals(stopped).deps.docker,
			);
			row = await db.query<{ container_status: string }>(
				'SELECT container_status::text AS container_status FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0].container_status).toBe(ContainerStatus.Error);
			stopped.shutdown();
		});

		it('ensureHqContainerRunning starts the stopped HQ container and no-ops without an HQ project', async () => {
			const { db } = ctx;
			const hq = await db.query<{ id: string }>(
				'SELECT id FROM projects WHERE is_internal = true LIMIT 1',
			);
			const hqId = hq.rows[0].id;
			await db.query(
				`UPDATE projects SET container_status = 'stopped'::container_status, container_id = 'hq-box'
				 WHERE id = $1`,
				[hqId],
			);

			const startCalls: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					...happyExec,
					inspectContainer: async (id: string) => ({
						Id: id,
						State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 },
						Config: { Image: 'stub' },
					}),
					startContainer: async (id: string) => {
						startCalls.push(id);
					},
				}),
			});

			await manager.ensureHqContainerRunning();
			expect(startCalls).toEqual(['hq-box']);
			const row = await db.query<{ container_status: string }>(
				'SELECT container_status::text AS container_status FROM projects WHERE id = $1',
				[hqId],
			);
			expect(row.rows[0].container_status).toBe(ContainerStatus.Running);

			// Hide the HQ project: the warm-up returns without touching Docker.
			await db.query('UPDATE projects SET is_internal = false WHERE id = $1', [hqId]);
			startCalls.length = 0;
			await manager.ensureHqContainerRunning();
			expect(startCalls).toEqual([]);
			await db.query('UPDATE projects SET is_internal = true WHERE id = $1', [hqId]);
			manager.shutdown();
		});
	});

	describe('stale dispatch sweep (detectOrphanedRuns)', () => {
		it('reaps a dispatch whose run went terminal without its completion settling', async () => {
			const { db } = ctx;
			const manager = createJobManager();
			const key = `${agentId}:${projectId}`;

			internals(manager).activeTaskRuns.add(taskId);
			internals(manager).activeProjectRuns.set(projectId, 1);
			manager.launchTask(
				key,
				(signal) =>
					new Promise((resolve) => {
						signal.addEventListener('abort', () => resolve(null));
					}),
				60 * 60 * 1000,
				{ memberId: agentId, taskId, projectId },
			);
			manager.registerLiveRun({
				runId: 'stale-live-run',
				memberId: agentId,
				taskId,
				projectId,
				teamId,
				taskKey: key,
			});
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, exit_code)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes', now() - interval '8 minutes', 0)`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Succeeded],
			);
			manager.getRunningTasks().get(key)!.startedAt = Date.now() - 10 * 60 * 1000;

			await (manager as unknown as JmInternals).detectOrphanedRuns();

			expect(manager.isTaskRunning(key)).toBe(false);
			expect(internals(manager).activeTaskRuns.has(taskId)).toBe(false);
			expect(internals(manager).activeProjectRuns.has(projectId)).toBe(false);
			expect(manager.getLiveRunIds().has('stale-live-run')).toBe(false);

			await waitForBackground();
			manager.shutdown();
		});

		it('leaves a dispatch alone while its run row is still active', async () => {
			const { db } = ctx;
			const manager = createJobManager();
			const key = `${agentId}:${projectId}`;

			internals(manager).activeTaskRuns.add(taskId);
			internals(manager).activeProjectRuns.set(projectId, 1);
			let settle: (() => void) | undefined;
			manager.launchTask(
				key,
				() =>
					new Promise<void>((resolve) => {
						settle = resolve;
					}),
				60 * 60 * 1000,
				{ memberId: agentId, taskId, projectId },
			);
			await db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes')`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Running],
			);
			manager.getRunningTasks().get(key)!.startedAt = Date.now() - 10 * 60 * 1000;

			await (manager as unknown as JmInternals).sweepStaleDispatches();

			expect(manager.isTaskRunning(key)).toBe(true);
			expect(internals(manager).activeTaskRuns.has(taskId)).toBe(true);

			settle?.();
			await waitForBackground();
			manager.shutdown();
		});
	});

	describe('container status sync', () => {
		it('fails project runs and cancels live runs when a running container drops to stopped', async () => {
			const { db } = ctx;
			await db.query(
				'UPDATE projects SET container_status = NULL, container_id = NULL WHERE id <> $1',
				[projectId],
			);
			await db.query(
				`UPDATE projects SET container_status = 'running'::container_status, container_id = 'sync-box'
				 WHERE id = $1`,
				[projectId],
			);
			const run = await db.query<{ id: string }>(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at)
				 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())
				 RETURNING id`,
				[teamId, agentId, taskId, HeartbeatRunStatus.Running],
			);

			const manager = createJobManager({
				docker: createStubDocker({
					inspectContainer: async (id: string) => ({
						Id: id,
						State: { Status: 'exited', Running: false, Pid: 0, ExitCode: 137 },
						Config: { Image: 'stub' },
					}),
				}),
			});
			const key = `${agentId}:${projectId}`;
			let aborted: unknown;
			manager.launchTask(
				key,
				(signal) =>
					new Promise<void>((resolve) => {
						signal.addEventListener('abort', () => {
							aborted = signal.reason;
							resolve();
						});
					}),
				60_000,
			);
			manager.registerLiveRun({
				runId: run.rows[0].id,
				memberId: agentId,
				taskId,
				projectId,
				teamId,
				taskKey: key,
			});

			await (manager as unknown as JmInternals).syncContainerStatuses();
			await waitForBackground();

			expect(aborted).toBe('container_stopped');
			expect(manager.getLiveRunIds().has(run.rows[0].id)).toBe(false);
			const runRow = await db.query<{ status: string }>(
				'SELECT status::text AS status FROM heartbeat_runs WHERE id = $1',
				[run.rows[0].id],
			);
			expect(runRow.rows[0].status).toBe(HeartbeatRunStatus.Failed);
			const project = await db.query<{ container_status: string }>(
				'SELECT container_status::text AS container_status FROM projects WHERE id = $1',
				[projectId],
			);
			expect(project.rows[0].container_status).toBe(ContainerStatus.Stopped);

			manager.shutdown();
			await db.query(
				'UPDATE projects SET container_status = NULL, container_id = NULL WHERE id = $1',
				[projectId],
			);
		});

		it('returns early when Docker is unreachable', async () => {
			const inspects: string[] = [];
			const manager = createJobManager({
				docker: createStubDocker({
					ping: async () => false,
					inspectContainer: async (id: string) => {
						inspects.push(id);
						return null;
					},
				}),
			});
			await (manager as unknown as JmInternals).syncContainerStatuses();
			expect(inspects).toEqual([]);
			manager.shutdown();
		});
	});

	describe('inbox archive', () => {
		it('archives read admin mentions past the retention window', async () => {
			const { db } = ctx;
			const manager = createJobManager();
			const user = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
			const comment = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, NULL, 'system'::comment_content_type, '{"kind":"test"}'::jsonb)
				 RETURNING id`,
				[taskId],
			);
			const mention = await db.query<{ id: string }>(
				`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id, created_at, read_at, archived_at)
				 VALUES ($1, $2, $3, $4, now() - interval '90 days', now() - interval '90 days', NULL)
				 RETURNING id`,
				[teamId, taskId, comment.rows[0].id, user.rows[0].id],
			);

			await (manager as unknown as JmInternals).archiveInboxItems();

			const archived = await db.query<{ archived_at: string | null }>(
				'SELECT archived_at FROM admin_mentions WHERE id = $1',
				[mention.rows[0].id],
			);
			expect(archived.rows[0].archived_at).not.toBeNull();

			await db.query('DELETE FROM admin_mentions WHERE id = $1', [mention.rows[0].id]);
			await db.query('DELETE FROM task_comments WHERE id = $1', [comment.rows[0].id]);
			manager.shutdown();
		});
	});

	describe('small maintenance jobs', () => {
		it('checkForUpdate no-ops outside a supervised worker', async () => {
			const manager = createJobManager();
			// Not a supervised compiled binary in tests: the check must return
			// without staging anything into the data dir.
			await (manager as unknown as JmInternals).checkForUpdate();
			const { readdirSync } = await import('node:fs');
			expect(readdirSync(ctx.dataDir).filter((f) => f.includes('update'))).toEqual([]);
			manager.shutdown();
		});

		it('refreshPricing refreshes via the pricing service and no-ops without one', async () => {
			let refreshes = 0;
			const withPricing = createJobManager({
				pricing: {
					refresh: async () => {
						refreshes++;
						return 7;
					},
				} as unknown as PricingService,
			});
			await (withPricing as unknown as JmInternals).refreshPricing();
			expect(refreshes).toBe(1);
			withPricing.shutdown();

			const without = createJobManager();
			await (without as unknown as JmInternals).refreshPricing();
			expect(refreshes).toBe(1);
			without.shutdown();
		});

		it('runTelemetry posts the anonymous snapshot when enabled and skips when disabled', async () => {
			const received: Array<Record<string, unknown>> = [];
			const server: Server = createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on('data', (c) => chunks.push(c));
				req.on('end', () => {
					received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end('{}');
				});
			});
			await new Promise<void>((resolve) => server.listen(0, resolve));
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			const endpoint = `http://127.0.0.1:${port}/telemetry`;

			const disabled = createJobManager({ telemetry: { enabled: false, endpoint } });
			await (disabled as unknown as JmInternals).runTelemetry();
			expect(received.length).toBe(0);
			disabled.shutdown();

			const enabled = createJobManager({ telemetry: { enabled: true, endpoint } });
			await (enabled as unknown as JmInternals).runTelemetry();
			expect(received.length).toBe(1);
			expect(typeof received[0].instance_id).toBe('string');
			expect(Number(received[0].teams)).toBeGreaterThan(0);
			enabled.shutdown();

			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		it('guarded swallows a throwing job body and blocks re-entrant execution', async () => {
			const manager = createJobManager();
			await expect(
				(manager as unknown as JmInternals).guarded('recovery-test-job', async () => {
					throw new Error('expected: guarded swallows this');
				}),
			).resolves.toBeUndefined();

			let running = 0;
			let peak = 0;
			let release: (() => void) | undefined;
			const body = () =>
				new Promise<void>((resolve) => {
					running++;
					peak = Math.max(peak, running);
					release = () => {
						running--;
						resolve();
					};
				});
			const first = (manager as unknown as JmInternals).guarded('recovery-reentrant', body);
			await (manager as unknown as JmInternals).guarded('recovery-reentrant', body);
			expect(peak).toBe(1);
			release?.();
			await first;
			manager.shutdown();
		});
	});
});
