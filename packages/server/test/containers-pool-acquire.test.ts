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

/**
 * A project of its own, so a case can reason about a pool of known size.
 *
 * Its own **team** too: a team holds at most one project, so asking for a second
 * one under the shared team hands back the shared project - and with it every
 * container the cases before it left in the pool.
 */
async function freshProject(name: string): Promise<string> {
	const team = await createTestTeam(db, { name: `${name} Co` });
	const res = await createTestProject(db, (await team.json()).data.id, { name });
	return (await res.json()).data.id;
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

	it('resumes a released container the backend stopped, rather than discarding it', async () => {
		// A managed backend reclaims an unused sandbox on its own schedule, so a
		// warm member being found stopped is routine rather than anomalous. Its
		// writable layer is intact - the clones and worktrees it already built are
		// still there - so the repair is a resume, not deleting the row and paying
		// to build a replacement while the sandbox lingers as an orphan.
		//
		// Its own project, so the pool holds exactly the one member under test:
		// with a sibling idle member available the ladder would satisfy the second
		// acquire from that instead, and the assertion would prove nothing.
		const ownProject = await freshProject('Resume Project');
		const docker = provisioningDocker();
		const first = await acquireRunContainer(deps(docker), ownProject, null);
		const stoppedId = first.containerId;
		await first.release();

		let running = false;
		vi.mocked(docker.inspectContainer).mockImplementation(async (id: string) => ({
			Id: id,
			State: {
				Status: id === stoppedId && !running ? 'exited' : 'running',
				Running: id !== stoppedId || running,
				Pid: 1,
				ExitCode: 0,
			},
			Config: { Image: 'stub' },
		}));
		vi.mocked(docker.startContainer).mockImplementation(async () => {
			running = true;
		});

		const second = await acquireRunContainer(deps(docker), ownProject, null);
		try {
			expect(second.containerId).toBe(stoppedId);
			expect(docker.startContainer).toHaveBeenCalledWith(stoppedId);
			expect(await poolRow(stoppedId)).toMatchObject({ state: 'busy' });
		} finally {
			await second.release();
		}
	});

	it('drops a member the engine no longer knows', async () => {
		const ownProject = await freshProject('Vanished Project');
		const docker = provisioningDocker();
		const acquired = await acquireRunContainer(deps(docker), ownProject, null);
		const goneId = acquired.containerId;
		await acquired.release();

		vi.mocked(docker.inspectContainer).mockImplementation(async (id: string) =>
			id === goneId
				? null
				: {
						Id: id,
						State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
						Config: { Image: 'stub' },
					},
		);
		const replacement = await acquireRunContainer(deps(docker), ownProject, null);
		try {
			expect(replacement.containerId).not.toBe(goneId);
			expect(await poolRow(goneId)).toBeUndefined();
		} finally {
			await replacement.release();
		}
	});

	it('keeps a member the engine could not answer for', async () => {
		// The third answer, which used to collapse into "gone". Deleting the row on
		// an unanswerable check loses the record of a live container and orphans it
		// on the backend, which is the strictly worse failure.
		const ownProject = await freshProject('Unanswerable Project');
		const acquired = await acquireRunContainer(deps(provisioningDocker()), ownProject, null);
		const blipId = acquired.containerId;
		await acquired.release();

		const blipDocker = provisioningDocker();
		vi.mocked(blipDocker.inspectContainer).mockRejectedValue(new Error('API unreachable'));
		await expect(acquireRunContainer(deps(blipDocker), ownProject, null)).rejects.toThrow(
			'API unreachable',
		);
		expect(await poolRow(blipId)).toBeDefined();
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

/**
 * The chat takes a container through the same ladder, which is what guarantees
 * the one it pins is not already serving a run.
 *
 * It used to read `projects.container_id` and use whatever that named. With one
 * container per project that was the same container either way; with a pool it
 * is the most recently provisioned or resumed one, which may be mid-run - so the
 * chat pinned a busy container and executed its turns on it, two workloads
 * sharing one memory cap. That is exactly the shared-fate failure the pool was
 * built to remove, reached from the one direction it was not guarding.
 */
describe('acquireRunContainer for the chat', () => {
	const CHAT_TASK = randomUUID();

	async function chatProject(): Promise<string> {
		const res = await createTestProject(db, teamId, { name: `Chat ${randomUUID().slice(0, 8)}` });
		return (await res.json()).data.id;
	}

	async function pinned(projectId: string): Promise<string[]> {
		const res = await db.query<{ container_id: string }>(
			`SELECT container_id FROM container_pool_members
			  WHERE project_id = $1 AND reserved_for_chat ORDER BY container_id`,
			[projectId],
		);
		return res.rows.map((r) => r.container_id);
	}

	it('never takes a container a run is already using', async () => {
		const project = await chatProject();
		const docker = provisioningDocker();
		const run = await acquireRunContainer(deps(docker), project, CHAT_TASK);
		try {
			const chat = await acquireRunContainer(deps(docker), project, null, 'chat');
			expect(chat.containerId).not.toBe(run.containerId);
			// And the run keeps its own: pinning must not reach across to it.
			expect(await poolRow(run.containerId)).toMatchObject({ state: 'busy' });
			expect(await pinned(project)).toEqual([chat.containerId]);
		} finally {
			await run.release();
		}
	});

	it('pins rather than claims, so the container reads idle and reserved', async () => {
		// That pair is what "the chat's container" means: `usable` then skips it in
		// the ladder, and `getActiveContainers` stops charging it to the budget.
		const project = await chatProject();
		const chat = await acquireRunContainer(deps(provisioningDocker()), project, null, 'chat');
		expect(await poolRow(chat.containerId)).toMatchObject({ state: 'idle' });
		expect(await pinned(project)).toEqual([chat.containerId]);
	});

	it('hands a task run a different container than the chat holds', async () => {
		// The mirror of the first case, and the property `usable` encodes.
		const project = await chatProject();
		const docker = provisioningDocker();
		const chat = await acquireRunContainer(deps(docker), project, null, 'chat');
		const run = await acquireRunContainer(deps(docker), project, CHAT_TASK);
		try {
			expect(run.containerId).not.toBe(chat.containerId);
		} finally {
			await run.release();
		}
	});

	it('gives the same container back to the session that already holds it', async () => {
		// A session reconnecting must not be handed a second container beside the
		// one it pinned - the ladder excludes reserved members by design, so this
		// rung has to come before it.
		const project = await chatProject();
		const docker = provisioningDocker();
		const first = await acquireRunContainer(deps(docker), project, null, 'chat');
		const second = await acquireRunContainer(deps(docker), project, null, 'chat');
		expect(second.containerId).toBe(first.containerId);
		expect(await pinned(project)).toEqual([first.containerId]);
	});

	it('does not release the pin when the turn ends', async () => {
		// The session holds its container across every turn; `teardown` is what
		// clears the reservation. Releasing here would hand it back after turn one.
		const project = await chatProject();
		const chat = await acquireRunContainer(deps(provisioningDocker()), project, null, 'chat');
		await chat.release();
		expect(await pinned(project)).toEqual([chat.containerId]);
		expect(await poolRow(chat.containerId)).toMatchObject({ state: 'idle' });
	});

	it('is not refused when the budget is full, because chat is exempt', async () => {
		// A queued task run is invisible and harmless; a queued chat turn is a
		// person watching a spinner. The budget already holds a container's worth
		// back for it up front, so charging it again would reserve twice.
		const project = await chatProject();
		const docker = provisioningDocker();
		const run = await acquireRunContainer(deps(docker), project, CHAT_TASK);
		await setMaxContainerMemoryGb(db, 1);
		try {
			const chat = await acquireRunContainer(deps(docker), project, null, 'chat');
			expect(chat.containerId).not.toBe(run.containerId);
		} finally {
			await setMaxContainerMemoryGb(db, 40);
			await run.release();
		}
	});

	it('points the project row at the container the chat took', async () => {
		// `container_id` is the operator's view - the Container page, the sync loop,
		// `container_error`. The chat's is the long-lived container they are most
		// likely to be looking at, so the column has to follow the ladder's choice.
		const project = await chatProject();
		const chat = await acquireRunContainer(deps(provisioningDocker()), project, null, 'chat');
		const row = await db.query<{ container_id: string | null }>(
			'SELECT container_id FROM projects WHERE id = $1',
			[project],
		);
		expect(row.rows[0].container_id).toBe(chat.containerId);
	});
});
