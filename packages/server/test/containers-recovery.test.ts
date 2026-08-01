import { AgentRuntimeStatus, HeartbeatRunStatus, TaskStatus, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import {
	type ContainerDeps,
	failProjectRuns,
	requeueContainerKilledRuns,
	verifyContainerWorkspace,
	wakeAgentsWithPendingWork,
} from '../src/services/containers';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let teamSlug: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;

function buildDeps(): ContainerDeps {
	return {
		db,
		docker: createStubDocker(),
		dataDir: '/tmp/test',
		wsManager: { broadcast: () => {} } as any,
		logs: new LogStreamBroker(),
	};
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find((t: any) => t.name === 'App Team').id;

	const teamRes = await createTestTeam(db, { name: 'Recovery Test Co', template_id: typeId });
	const team = (await teamRes.json()).data;
	teamId = team.id;
	teamSlug = team.slug;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Recovery Test Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentsRes = await app.request(`/api/projects/${await projectSlugFor(db, teamId)}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: 'Recovery Test Task',
			assignee_id: agentId,
		}),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function clearState(): Promise<void> {
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
	await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
	await db.query('UPDATE execution_locks SET released_at = now() WHERE released_at IS NULL');
	await db.query(
		'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
		[AgentRuntimeStatus.Idle, agentId],
	);
}

async function insertRunningRun(): Promise<string> {
	const res = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status) RETURNING id`,
		[teamId, agentId, taskId, HeartbeatRunStatus.Running],
	);
	return res.rows[0].id;
}

describe('failProjectRuns', () => {
	it('marks running heartbeat_runs in the project as failed with the given reason', async () => {
		await clearState();
		const runId = await insertRunningRun();
		await db.query(
			'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
			[AgentRuntimeStatus.Active, agentId],
		);

		await failProjectRuns(buildDeps(), projectId, projectSlug, teamId, 'container_error');

		const run = await db.query<{ status: string; error: string; exit_code: number }>(
			'SELECT status, error, exit_code FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Failed);
		expect(run.rows[0].error).toBe('container_error');
		expect(run.rows[0].exit_code).toBe(-1);

		const agent = await db.query<{ runtime_status: string }>(
			'SELECT runtime_status FROM member_agents WHERE id = $1',
			[agentId],
		);
		expect(agent.rows[0].runtime_status).toBe(AgentRuntimeStatus.Idle);
	});

	it('does not touch runs in other projects', async () => {
		await clearState();
		const runId = await insertRunningRun();

		await failProjectRuns(
			buildDeps(),
			'00000000-0000-0000-0000-000000000000',
			'unknown-project',
			teamId,
			'container_error',
		);

		const run = await db.query<{ status: string }>(
			'SELECT status FROM heartbeat_runs WHERE id = $1',
			[runId],
		);
		expect(run.rows[0].status).toBe(HeartbeatRunStatus.Running);
	});

	it('releases execution_locks for the project tasks', async () => {
		await clearState();
		await insertRunningRun();
		await db.query('INSERT INTO execution_locks (task_id, member_id) VALUES ($1, $2)', [
			taskId,
			agentId,
		]);

		await failProjectRuns(buildDeps(), projectId, projectSlug, teamId, 'container_stopped');

		const lock = await db.query<{ released_at: string | null }>(
			'SELECT released_at FROM execution_locks WHERE task_id = $1 AND member_id = $2',
			[taskId, agentId],
		);
		expect(lock.rows[0].released_at).not.toBeNull();
	});

	it('broadcasts heartbeat_runs and member_agents row changes', async () => {
		await clearState();
		await insertRunningRun();
		await db.query(
			'UPDATE member_agents SET runtime_status = $1::agent_runtime_status WHERE id = $2',
			[AgentRuntimeStatus.Active, agentId],
		);
		const broadcasts: Array<{ table: string }> = [];
		const deps: ContainerDeps = {
			...buildDeps(),
			wsManager: {
				broadcast: (_room: string, msg: { table: string }) => {
					broadcasts.push({ table: msg.table });
				},
			} as any,
		};

		await failProjectRuns(deps, projectId, projectSlug, teamId, 'container_error');

		expect(broadcasts.some((b) => b.table === 'heartbeat_runs')).toBe(true);
		expect(broadcasts.some((b) => b.table === 'member_agents')).toBe(true);
	});
});

describe('requeueContainerKilledRuns', () => {
	it('creates wakeups for runs failed with container_error', async () => {
		await clearState();
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, error)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '5 minutes', now() - interval '4 minutes', 'container_error')`,
			[teamId, agentId, taskId, HeartbeatRunStatus.Failed],
		);

		const count = await requeueContainerKilledRuns(buildDeps(), projectId, projectSlug, teamId);
		expect(count).toBe(1);

		const wakeups = await db.query<{ payload: Record<string, unknown> }>(
			`SELECT payload FROM agent_wakeup_requests
			 WHERE member_id = $1 AND status = $2::wakeup_status
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, WakeupStatus.Queued],
		);
		expect((wakeups.rows[0]?.payload as Record<string, unknown>)?.reason).toBe(
			'container_recovery',
		);
	});

	it('skips runs failed with container_stopped', async () => {
		await clearState();
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, error)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '5 minutes', now() - interval '4 minutes', 'container_stopped')`,
			[teamId, agentId, taskId, HeartbeatRunStatus.Failed],
		);

		const count = await requeueContainerKilledRuns(buildDeps(), projectId, projectSlug, teamId);
		expect(count).toBe(0);
	});

	it('skips runs that already had a successor run started', async () => {
		await clearState();
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at, error)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '10 minutes', now() - interval '9 minutes', 'container_error')`,
			[teamId, agentId, taskId, HeartbeatRunStatus.Failed],
		);
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '5 minutes', now() - interval '4 minutes')`,
			[teamId, agentId, taskId, HeartbeatRunStatus.Succeeded],
		);

		const count = await requeueContainerKilledRuns(buildDeps(), projectId, projectSlug, teamId);
		expect(count).toBe(0);
	});
});

describe('wakeAgentsWithPendingWork', () => {
	it('queues a container_start wakeup for an enabled agent with a non-terminal assigned task', async () => {
		await clearState();
		await db.query(`UPDATE member_agents SET admin_status = 'enabled' WHERE id = $1`, [agentId]);

		await wakeAgentsWithPendingWork(db, projectId, teamId);
		await waitForBackground();

		const wakeups = await db.query<{ payload: Record<string, unknown>; source: string }>(
			`SELECT payload, source FROM agent_wakeup_requests
			 WHERE member_id = $1 AND status = $2::wakeup_status
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, WakeupStatus.Queued],
		);
		expect(wakeups.rows.length).toBe(1);
		expect(wakeups.rows[0].source).toBe('automation');
		expect((wakeups.rows[0].payload as Record<string, unknown>).trigger).toBe('container_start');
	});

	it('does not wake an agent whose only task is in a terminal status', async () => {
		await clearState();
		const orig = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
			taskId,
		]);
		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			TaskStatus.Done,
			taskId,
		]);

		await wakeAgentsWithPendingWork(db, projectId, teamId);
		await waitForBackground();

		const wakeups = await db.query<{ id: string }>(
			`SELECT id FROM agent_wakeup_requests WHERE member_id = $1 AND status = $2::wakeup_status`,
			[agentId, WakeupStatus.Queued],
		);
		expect(wakeups.rows.length).toBe(0);

		await db.query('UPDATE tasks SET status = $1::task_status WHERE id = $2', [
			orig.rows[0].status,
			taskId,
		]);
	});
});

describe('verifyContainerWorkspace', () => {
	// A docker whose single exec captures the probe Cmd and returns a scripted exit
	// code — extends createStubDocker per the inline-mock rule.
	function probeDocker(exitCode: number) {
		let captured: string[] = [];
		const docker = createStubDocker({
			execCreate: async (_id: string, config: { Cmd: string[] }) => {
				captured = config.Cmd;
				return 'exec-1';
			},
			execInspect: async () => ({ ExitCode: exitCode, Running: false, Pid: 0 }),
		});
		return { docker, cmd: () => captured };
	}

	it('probes both /workspace and /worktrees writability and passes on exit 0', async () => {
		const { docker, cmd } = probeDocker(0);
		expect(await verifyContainerWorkspace(docker, 'cid')).toBe(true);
		const script = cmd()[2] ?? '';
		expect(script).toContain('/workspace');
		// A stale /worktrees is now caught too — not just /workspace.
		expect(script).toContain('/worktrees');
	});

	it('fails (→ triggers a rebuild) when the probe exits non-zero', async () => {
		const { docker } = probeDocker(1);
		expect(await verifyContainerWorkspace(docker, 'cid')).toBe(false);
	});

	it('returns false (never throws) when the exec itself fails', async () => {
		const docker = createStubDocker({
			execCreate: async () => {
				throw new Error('current working directory is outside of container mount namespace root');
			},
		});
		await expect(verifyContainerWorkspace(docker, 'cid')).resolves.toBe(false);
	});
});

describe('failProjectRuns blast radius', () => {
	/** A running run attributed to a specific container. */
	async function runOnContainer(containerId: string | null): Promise<string> {
		const res = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, container_id)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, $5) RETURNING id`,
			[teamId, agentId, taskId, HeartbeatRunStatus.Running, containerId],
		);
		return res.rows[0].id;
	}

	const statusOf = async (runId: string): Promise<string> =>
		(
			await db.query<{ status: string }>(
				'SELECT status::text AS status FROM heartbeat_runs WHERE id = $1',
				[runId],
			)
		).rows[0].status;

	it('fails only the runs on the dead container, leaving siblings running', async () => {
		// The property the whole pool exists for. Before runs recorded their
		// container this was unanswerable, so one container's OOM failed every run
		// in the project - the shared-fate blast radius the rearchitecture removes.
		await clearState();
		const dead = await runOnContainer('ctr-dead');
		const sibling = await runOnContainer('ctr-alive');

		await failProjectRuns(
			buildDeps(),
			projectId,
			projectSlug,
			teamId,
			'container_error',
			'ctr-dead',
		);

		expect(await statusOf(dead)).toBe(HeartbeatRunStatus.Failed);
		expect(await statusOf(sibling)).toBe(HeartbeatRunStatus.Running);
	});

	it('still fails an unattributable run, which nothing can prove is alive', async () => {
		// Rows written before runs carried a container id. Leaving them Running
		// forever would hold the agent's slot and its execution lock.
		await clearState();
		const legacy = await runOnContainer(null);
		await failProjectRuns(
			buildDeps(),
			projectId,
			projectSlug,
			teamId,
			'container_error',
			'ctr-dead',
		);
		expect(await statusOf(legacy)).toBe(HeartbeatRunStatus.Failed);
	});

	it('fails everything when no container is named', async () => {
		// Project teardown and the boot sweep have no single container to blame.
		await clearState();
		const a = await runOnContainer('ctr-1');
		const b = await runOnContainer('ctr-2');
		await failProjectRuns(buildDeps(), projectId, projectSlug, teamId, 'container_stopped');
		expect(await statusOf(a)).toBe(HeartbeatRunStatus.Failed);
		expect(await statusOf(b)).toBe(HeartbeatRunStatus.Failed);
	});

	it("leaves a surviving run's execution lock held", async () => {
		// Releasing it would let a second run be dispatched onto a task another
		// container is still actively working. Two tasks, because one active run
		// per task is already enforced - concurrent runs are never on the same one.
		await clearState();
		const other = await db.query<{ id: string }>(
			`INSERT INTO tasks (project_id, team_id, number, identifier, title)
			 VALUES ($1, $2, 9001, 'REC-9001', 'sibling') RETURNING id`,
			[projectId, teamId],
		);
		const otherTaskId = other.rows[0].id;

		await runOnContainer('ctr-dead');
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, container_id)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, 'ctr-alive')`,
			[teamId, agentId, otherTaskId, HeartbeatRunStatus.Running],
		);
		await db.query(`INSERT INTO execution_locks (task_id, member_id) VALUES ($1, $2)`, [
			otherTaskId,
			agentId,
		]);

		await failProjectRuns(
			buildDeps(),
			projectId,
			projectSlug,
			teamId,
			'container_error',
			'ctr-dead',
		);

		const held = await db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM execution_locks
			  WHERE task_id = $1 AND released_at IS NULL`,
			[otherTaskId],
		);
		expect(held.rows[0].c).toBe(1);
	});
});
