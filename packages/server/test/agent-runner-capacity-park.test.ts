// The capacity park: what a run does when the pool ladder has nothing to give.
//
// Before this, `runAgent` returned immediately on `PoolCapacityError` and left
// its `heartbeat_runs` row `queued` with nobody owning it - so the row blocked
// the retry of its own wakeup via `isTaskBusyInDb`, and 120s later the orphan
// pass failed it as "Orphaned: run never started" and started a second run.
// Capacity is transient, so the run now waits in place instead.
//
// Capacity is exhausted the way `containers-pool-acquire.test.ts` does it (every
// pool member busy + a 1 GB instance budget), and the park bounds come in
// through `RunnerDeps.capacityPark` because the real ceiling is minutes long.

import { ContainerStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { setMaxContainerMemoryGb } from '../src/lib/system-meta';
import type { Env } from '../src/lib/types';
import { type RunnerDeps, runAgent } from '../src/services/agent-runner';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { CAPACITY_PARK_QUEUED_REASON } from '../src/services/run-concurrency';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let adminToken: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let agentSlug: string;

let seq = 0;
function parkDocker(): ContainerEngine {
	const base = createStubDocker({
		createContainer: vi.fn(async () => ({ Id: `park-cid-${seq++}`, Warnings: [] })),
		startContainer: vi.fn(async () => {}),
		execCreate: vi.fn(async () => 'exec-park'),
		// Flip produced_output the way the MCP tool layer does, so an exit-0 run
		// reads as a genuine success rather than "run produced no output".
		execStart: vi.fn(async () => {
			await db.query(
				`UPDATE heartbeat_runs SET produced_output = true WHERE member_id = $1 AND status = 'running'`,
				[agentId],
			);
			return { stdout: 'done', stderr: '' };
		}),
		execInspect: vi.fn(async () => ({ ExitCode: 0, Running: false, Pid: 0 })),
		inspectContainer: vi.fn(async (id: string) => ({
			Id: id,
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'stub' },
		})),
	});
	return base as unknown as ContainerEngine;
}

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
	return {
		db,
		docker: parkDocker(),
		masterKeyManager,
		serverPort: 3000,
		dataDir,
		logs: new LogStreamBroker(),
		...extra,
	};
}

function agent() {
	return { id: agentId, title: 'Park Runner', slug: agentSlug, team_id: teamId };
}

function project() {
	return {
		id: projectId,
		slug: projectSlug,
		team_id: teamId,
		team_slug: 'park-co',
		container_id: null,
		container_status: ContainerStatus.Stopped,
		designated_repo_id: null,
		is_internal: false,
	};
}

async function makeTask(title: string) {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, assignee_id: agentId }),
	});
	const row = (await res.json()).data;
	return {
		id: row.id as string,
		identifier: row.identifier as string,
		title,
		description: 'Park description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
	};
}

/** Exhaust the instance memory budget so the pool ladder can only queue. */
async function blockCapacity() {
	await db.query(`UPDATE container_pool_members SET state = 'busy'`);
	await setMaxContainerMemoryGb(db, 1);
}

async function freeCapacity() {
	await setMaxContainerMemoryGb(db, 40);
	await db.query(`UPDATE container_pool_members SET state = 'idle'`);
}

async function runRow(id: string) {
	const r = await db.query<{
		status: string;
		queued_reason: string | null;
		started_at: string | null;
		error: string | null;
	}>('SELECT status, queued_reason, started_at, error FROM heartbeat_runs WHERE id = $1', [id]);
	return r.rows[0];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Park Co' });
	teamId = (await teamRes.json()).data.id;

	// The runner resolves a credential before it ever reaches the pool ladder, so
	// without one every run here fails on configuration instead of parking.
	const originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-park-key',
			label: 'anthropic-park',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Park Project',
		description: 'Capacity park project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	const agentRow = (await agentsRes.json()).data[0];
	agentId = agentRow.id;
	agentSlug = agentRow.slug;
});

afterAll(async () => {
	await freeCapacity();
	await safeClose(db);
});

describe('runAgent capacity park', () => {
	it('waits in place and starts the same run once capacity frees', async () => {
		const task = await makeTask('Parks then runs');
		await blockCapacity();

		const pending = runAgent(
			deps({ capacityPark: { pollMs: 25, maxMs: 20_000 } }),
			agent(),
			task,
			project(),
		);

		// The park has to be observable while it is happening: the row stays
		// `queued` and says what it is waiting for, which is what the run comment
		// and the run detail page render.
		await vi.waitFor(
			async () => {
				const runs = await db.query<{ id: string; status: string; queued_reason: string | null }>(
					'SELECT id, status, queued_reason FROM heartbeat_runs WHERE task_id = $1',
					[task.id],
				);
				expect(runs.rows).toHaveLength(1);
				expect(runs.rows[0].status).toBe('queued');
				expect(runs.rows[0].queued_reason).toBe(CAPACITY_PARK_QUEUED_REASON);
			},
			{ timeout: 10_000, interval: 25 },
		);

		await freeCapacity();
		const result = await pending;

		// Same run row throughout - the point of parking rather than requeuing is
		// that no second run (and no second Run comment) is ever created.
		const all = await db.query<{ id: string }>('SELECT id FROM heartbeat_runs WHERE task_id = $1', [
			task.id,
		]);
		expect(all.rows).toHaveLength(1);
		expect(all.rows[0].id).toBe(result.heartbeatRunId);

		const row = await runRow(result.heartbeatRunId as string);
		expect(row.status).toBe('succeeded');
		expect(row.started_at).not.toBeNull();
		expect(result.requeued).toBeFalsy();
	});

	it('gives the work back to the queue as cancelled, never failed, once the ceiling passes', async () => {
		const task = await makeTask('Parks then gives up');
		await blockCapacity();
		try {
			const result = await runAgent(
				deps({ capacityPark: { pollMs: 10, maxMs: 60 } }),
				agent(),
				task,
				project(),
			);

			expect(result.requeued).toBe(true);
			const row = await runRow(result.heartbeatRunId as string);
			// Cancelled, not failed: the instance being full is not the agent
			// failing, and nothing should post a failure ping for it.
			expect(row.status).toBe('cancelled');
			expect(row.error).toContain('returning this run to the queue');
		} finally {
			await freeCapacity();
		}
	});

	it('leaves no run that the orphan pass would reap as never started', async () => {
		// The bug this whole change exists for: a row left `queued` and unowned is
		// terminal-but-never-started 120s later. After the ceiling it must already
		// be terminal, so the orphan pass has nothing to find and the requeued
		// wakeup is not blocked behind it by `isTaskBusyInDb`.
		const task = await makeTask('Leaves nothing stranded');
		await blockCapacity();
		try {
			await runAgent(deps({ capacityPark: { pollMs: 10, maxMs: 60 } }), agent(), task, project());
		} finally {
			await freeCapacity();
		}

		const stranded = await db.query(
			`SELECT 1 FROM heartbeat_runs
			 WHERE task_id = $1 AND status IN ('queued', 'running')`,
			[task.id],
		);
		expect(stranded.rows).toHaveLength(0);
	});
});
