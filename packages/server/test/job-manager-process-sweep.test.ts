import { ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { waitForBackground } from '../src/lib/background';
import { ContainerLogStreamer } from '../src/services/container-logs';
import type { ContainerProcessInfo } from '../src/services/docker';
import { JobManager, type JobManagerDeps } from '../src/services/job-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { SWEEP_MIN_AGE_SECS } from '../src/services/process-sweeper';
import { authHeader, createStubDocker, createTestProject, createTestTeam } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

// The startup dangling-process sweep (4th reconcile pass) and the shutdown
// live-run reap: Docker can't kill an exec'd process, so anything in flight
// when the previous server lifetime ended keeps running inside the warm
// project containers until these paths reap it.

let ctx: ServerTestContext;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;

const json = { 'Content-Type': 'application/json' };
const CONTAINER_ID = 'sweep-container-1';

const OLD = SWEEP_MIN_AGE_SECS + 600;

function proc(over: Partial<ContainerProcessInfo>): ContainerProcessInfo {
	return { pid: 100, runId: null, hasHezoSock: false, ageSecs: OLD, cmdline: 'sleep 300', ...over };
}

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

// Keeps the earlier container passes (restart / stale-mount probe) green so the
// sweep pass under test is reached without rebuild cascades.
const happyExec = {
	execCreate: async () => 'exec-ok',
	execStart: async () => ({ stdout: 'ok', stderr: '' }),
	execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
	inspectContainer: async () => ({
		Id: CONTAINER_ID,
		State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
		Config: { Image: 'stub' },
	}),
};

async function insertRun(status: HeartbeatRunStatus): Promise<string> {
	const r = await ctx.db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, now(), ${status === HeartbeatRunStatus.Running ? 'NULL' : 'now()'})
		 RETURNING id`,
		[teamId, agentId, taskId, status],
	);
	return r.rows[0].id;
}

beforeAll(async () => {
	ctx = await createTestContext();
	const { app, db, token } = ctx;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Sweep JM Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Sweep JM Project',
		description: 'Dangling-process sweep coverage.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	await db.query(
		`UPDATE projects SET container_id = $1, container_status = $2::container_status WHERE id = $3`,
		[CONTAINER_ID, ContainerStatus.Running, projectId],
	);

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
		body: JSON.stringify({ project_id: projectId, title: 'Sweep Task', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
	await waitForBackground();
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

describe('startup dangling-process sweep', () => {
	it('kills stranded-run, legacy, and bridge processes but preserves succeeded-run and young ones', async () => {
		const succeededId = await insertRun(HeartbeatRunStatus.Succeeded);
		// A run stranded `running` by the previous lifetime: the earlier reconcile
		// pass flips it to failed BEFORE the sweep runs, so its tree must die.
		const strandedId = await insertRun(HeartbeatRunStatus.Running);

		const kills: Array<{ containerId: string; pids: number[] }> = [];
		const docker = createStubDocker({
			...happyExec,
			listHezoProcesses: async (): Promise<ContainerProcessInfo[]> => [
				proc({ pid: 11, runId: succeededId, cmdline: 'node dev-server.js' }),
				proc({ pid: 12, runId: strandedId, cmdline: 'node some-cli' }),
				proc({ pid: 13, runId: null, hasHezoSock: true, cmdline: 'ssh git@github.com' }),
				proc({ pid: 14, cmdline: '/bin/sh /usr/local/bin/hezo-ssh-bridge tok host 1' }),
				proc({ pid: 15, runId: strandedId, ageSecs: 5, cmdline: 'node young-cli' }),
			],
			killPids: async (containerId: string, pids: number[]) => {
				kills.push({ containerId, pids });
			},
		});

		const manager = createJobManager({ docker });
		await manager.reconcileOnStartup();
		manager.shutdown();

		const stranded = await ctx.db.query<{ status: string }>(
			'SELECT status::text AS status FROM heartbeat_runs WHERE id = $1',
			[strandedId],
		);
		expect(stranded.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(kills).toEqual([{ containerId: CONTAINER_ID, pids: [12, 13, 14] }]);
	});

	it('skips the sweep entirely when docker is unreachable', async () => {
		let scanned = 0;
		const docker = createStubDocker({
			ping: async () => false,
			listHezoProcesses: async (): Promise<ContainerProcessInfo[]> => {
				scanned++;
				return [];
			},
		});
		const manager = createJobManager({ docker });
		await manager.reconcileOnStartup();
		manager.shutdown();
		expect(scanned).toBe(0);
	});

	it('a scan failure logs and continues without failing reconciliation', async () => {
		const docker = createStubDocker({
			...happyExec,
			listHezoProcesses: async (): Promise<ContainerProcessInfo[]> => {
				throw new Error('container stopped mid-sweep');
			},
			killPids: async () => {
				throw new Error('should not be called');
			},
		});
		const manager = createJobManager({ docker });
		await expect(manager.reconcileOnStartup()).resolves.toBeUndefined();
		manager.shutdown();
	});

	it('skips the kill exec when nothing qualifies', async () => {
		const succeededId = await insertRun(HeartbeatRunStatus.Succeeded);
		let killCalls = 0;
		const docker = createStubDocker({
			...happyExec,
			listHezoProcesses: async (): Promise<ContainerProcessInfo[]> => [
				proc({ pid: 21, runId: succeededId, cmdline: 'node dev-server.js' }),
			],
			killPids: async () => {
				killCalls++;
			},
		});
		const manager = createJobManager({ docker });
		await manager.reconcileOnStartup();
		manager.shutdown();
		expect(killCalls).toBe(0);
	});
});

describe('killLiveRunProcesses (shutdown reap)', () => {
	it("kills each live run's marker in its project container, bounded and best-effort", async () => {
		// Earlier reconcile passes may have rebuilt the stub project container;
		// re-pin the id this test asserts against.
		await ctx.db.query(
			`UPDATE projects SET container_id = $1, container_status = $2::container_status WHERE id = $3`,
			[CONTAINER_ID, ContainerStatus.Running, projectId],
		);
		const runId = await insertRun(HeartbeatRunStatus.Running);
		const kills: Array<{ containerId: string; runId: string }> = [];
		const docker = createStubDocker({
			killRunProcesses: async (containerId: string, rid: string) => {
				kills.push({ containerId, runId: rid });
			},
		});
		const manager = createJobManager({ docker });
		manager.registerLiveRun({
			runId,
			memberId: agentId,
			taskId,
			projectId,
			teamId,
			taskKey: `${agentId}:${projectId}`,
		});

		await manager.killLiveRunProcesses();
		manager.shutdown();

		expect(kills).toEqual([{ containerId: CONTAINER_ID, runId }]);
	});

	it('is a no-op with no live runs and survives kill failures', async () => {
		const failing = createStubDocker({
			killRunProcesses: async () => {
				throw new Error('daemon gone');
			},
		});
		const empty = createJobManager({ docker: failing });
		await expect(empty.killLiveRunProcesses()).resolves.toBeUndefined();
		empty.shutdown();

		const runId = await insertRun(HeartbeatRunStatus.Running);
		const manager = createJobManager({ docker: failing });
		manager.registerLiveRun({
			runId,
			memberId: agentId,
			taskId,
			projectId,
			teamId,
			taskKey: `${agentId}:${projectId}`,
		});
		await expect(manager.killLiveRunProcesses()).resolves.toBeUndefined();
		manager.shutdown();
	});
});
