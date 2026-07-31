import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import { setMaxContainerMemoryGb } from '../src/lib/system-meta';
import {
	acquireRunContainer,
	type ContainerDeps,
	PoolCapacityError,
} from '../src/services/containers';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { safeClose } from './helpers';
import { createStubDocker, createTestApp, createTestProject, createTestTeam } from './helpers/app';

/**
 * The pool, exercised end to end rather than through the pure ladder.
 *
 * `selectPoolMember` is unit-tested on its own; what this file covers is the
 * half that cannot be pure - that a claim actually excludes a second run, that a
 * release makes the container available again, and that task affinity survives a
 * round trip through the table. The first of those is the whole point of the
 * pool: before it, concurrent runs in a project shared one container and one
 * memory cap, so one greedy run failed every sibling.
 */

let db: Db;
let dataDir: string;
let teamId: string;
let projectId: string;

// `last_task_id` is a real uuid column, so affinity has to be keyed by one.
const TASK_A = randomUUID();
const TASK_B = randomUUID();
const TASK_AFFINE = randomUUID();
const TASK_OTHER = randomUUID();
const TASK_NOTED = randomUUID();
const TASK_HOLDER = randomUUID();
const TASK_BLOCKED = randomUUID();

let seq = 0;
function provisioningDocker(): ContainerEngine {
	return createStubDocker({
		createContainer: vi.fn(async () => ({ Id: `pool-cid-${seq++}`, Warnings: [] })),
		startContainer: vi.fn(async () => {}),
		execCreate: vi.fn(async () => 'exec-x'),
		execStart: vi.fn(async () => ({ stdout: '', stderr: '' })),
		execInspect: vi.fn(async () => ({ ExitCode: 0, Running: false, Pid: 0 })),
		inspectContainer: vi.fn(async (id: string) => ({
			Id: id,
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'stub' },
		})),
	});
}

function deps(docker: ContainerEngine): ContainerDeps {
	return { db, docker, dataDir };
}

async function poolRow(containerId: string) {
	const res = await db.query<{ state: string; last_task_id: string | null }>(
		`SELECT state::text AS state, last_task_id FROM container_pool_members WHERE container_id = $1`,
		[containerId],
	);
	return res.rows[0];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	dataDir = ctx.dataDir;
	const teamRes = await createTestTeam(db, { name: 'Pool Co' });
	teamId = (await teamRes.json()).data.id;
	const projRes = await createTestProject(db, teamId, { name: 'Pool Project' });
	projectId = (await projRes.json()).data.id;
	// Room for several containers, so the cap is not what these assertions hit.
	await setMaxContainerMemoryGb(db, 40);
});

afterAll(async () => {
	await safeClose(db);
});

describe('acquireRunContainer', () => {
	it('registers the container it provisions as a pool member and marks it busy', async () => {
		const acquired = await acquireRunContainer(deps(provisioningDocker()), projectId, null);
		try {
			expect(await poolRow(acquired.containerId)).toMatchObject({ state: 'busy' });
		} finally {
			await acquired.release();
		}
	});

	it('never hands the same container to two concurrent runs', async () => {
		// The rule the pool exists for. Two runs, no release between them: the
		// second must get its own container, because sharing one is what let a
		// memory blowout in one run fail every sibling run in the project.
		const docker = provisioningDocker();
		const first = await acquireRunContainer(deps(docker), projectId, TASK_A);
		const second = await acquireRunContainer(deps(docker), projectId, TASK_B);
		try {
			expect(second.containerId).not.toBe(first.containerId);
			expect(await poolRow(first.containerId)).toMatchObject({ state: 'busy' });
			expect(await poolRow(second.containerId)).toMatchObject({ state: 'busy' });
		} finally {
			await first.release();
			await second.release();
		}
	});

	it('reuses a released container rather than provisioning another', async () => {
		const docker = provisioningDocker();
		const first = await acquireRunContainer(deps(docker), projectId, null);
		const reusedId = first.containerId;
		await first.release();

		const second = await acquireRunContainer(deps(docker), projectId, null);
		try {
			expect(second.containerId).toBe(reusedId);
		} finally {
			await second.release();
		}
	});

	it('prefers the container that last served this task', async () => {
		// Affinity is the common case, not an optimization: a task gets many runs
		// (replies, retries, timeouts), and its worktree and node_modules are
		// already built on the container that served the last one.
		const docker = provisioningDocker();
		const forTask = await acquireRunContainer(deps(docker), projectId, TASK_AFFINE);
		const affineId = forTask.containerId;
		const other = await acquireRunContainer(deps(docker), projectId, TASK_OTHER);
		await forTask.release();
		await other.release();

		const again = await acquireRunContainer(deps(docker), projectId, TASK_AFFINE);
		try {
			expect(again.containerId).toBe(affineId);
		} finally {
			await again.release();
		}
	});

	it('records the task on release even when the run failed', async () => {
		const acquired = await acquireRunContainer(deps(provisioningDocker()), projectId, TASK_NOTED);
		await acquired.release();
		expect(await poolRow(acquired.containerId)).toMatchObject({
			state: 'idle',
			last_task_id: TASK_NOTED,
		});
	});

	it('release is idempotent', async () => {
		const acquired = await acquireRunContainer(deps(provisioningDocker()), projectId, null);
		await acquired.release();
		await acquired.release();
		expect(await poolRow(acquired.containerId)).toMatchObject({ state: 'idle' });
	});

	it('throws PoolCapacityError rather than over-creating when the cap is full', async () => {
		// The dispatcher already refuses to start a run it has no capacity for, so
		// reaching here means capacity went away in between - requeue, not fail.
		//
		// Every member is put to busy first, deliberately: a project that still has
		// a warm idle container is correctly *not* blocked, because reusing a
		// container already running consumes no new budget. The budget only bites
		// when the pool has nothing left to give.
		await db.query(`UPDATE container_pool_members SET state = 'busy' WHERE project_id = $1`, [
			projectId,
		]);
		await setMaxContainerMemoryGb(db, 1);
		try {
			await expect(
				acquireRunContainer(deps(provisioningDocker()), projectId, TASK_BLOCKED),
			).rejects.toBeInstanceOf(PoolCapacityError);
		} finally {
			await setMaxContainerMemoryGb(db, 40);
			await db.query(`UPDATE container_pool_members SET state = 'idle' WHERE project_id = $1`, [
				projectId,
			]);
		}
	});
});
