import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/database';
import { setMaxContainerMemoryGb } from '../src/lib/system-meta';
import {
	acquireRunContainer,
	type ContainerDeps,
	PoolCapacityError,
} from '../src/services/containers';
import { listAllContainers } from '../src/services/sandbox/pool-db';
import type { ContainerConfig, ContainerEngine } from '../src/services/sandbox/types';
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
		//
		// Instance-wide rather than for this project alone, because an idle member
		// anywhere is now headroom - the acquire path reclaims it rather than
		// queueing. This case is the one where there is genuinely nothing to take.
		await db.query(`UPDATE container_pool_members SET state = 'busy'`);
		await setMaxContainerMemoryGb(db, 1);
		try {
			await expect(
				acquireRunContainer(deps(provisioningDocker()), projectId, TASK_BLOCKED),
			).rejects.toBeInstanceOf(PoolCapacityError);
		} finally {
			await setMaxContainerMemoryGb(db, 40);
			await db.query(`UPDATE container_pool_members SET state = 'idle'`);
		}
	});
});

/**
 * The other half of the reported failure. Retiring a working project's surplus
 * containers on the idle cron frees the budget within a minute; this is what
 * closes the gap in between, when a run would otherwise sit queued behind memory
 * its neighbour is demonstrably not using.
 *
 * A container belongs to its project for life - it is built around that project's
 * workspace mount, repo clone and git identity - so the only way that memory can
 * serve another project is for the container to go and a fresh one to be built.
 */
describe('acquireRunContainer reclaiming from another project', () => {
	const TASK_STARVED = randomUUID();
	const CAP_BYTES = 2 * 1024 ** 3;
	let removed: string[];
	let stopped: string[];

	function reclaimingDocker(): ContainerEngine {
		return createStubDocker({
			createContainer: vi.fn(async () => ({ Id: `reclaim-cid-${seq++}`, Warnings: [] })),
			startContainer: vi.fn(async () => {}),
			execCreate: vi.fn(async () => 'exec-x'),
			execStart: vi.fn(async () => ({ stdout: '', stderr: '' })),
			execInspect: vi.fn(async () => ({ ExitCode: 0, Running: false, Pid: 0 })),
			inspectContainer: vi.fn(async (id: string) => ({
				Id: id,
				State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
				Config: { Image: 'stub' },
			})),
			removeContainer: vi.fn(async (id: string) => {
				removed.push(id);
			}),
			stopContainer: vi.fn(async (id: string) => {
				stopped.push(id);
			}),
		});
	}

	/** Start from an empty fleet so the budget arithmetic is exactly what each case states. */
	async function emptyFleet(): Promise<void> {
		await db.query('DELETE FROM container_pool_members');
		await db.query('UPDATE projects SET container_id = NULL, container_status = NULL');
		removed = [];
		stopped = [];
	}

	async function seedIdle(
		project: string,
		containerId: string,
		over: { idleMin?: number; unpushed?: boolean; ageMin?: number } = {},
	): Promise<void> {
		// `ageMin` defaults well past the reclaim age floor, and above `idleMin`:
		// a container cannot have been idle for longer than it has existed, and a
		// row left at `created_at = now()` reads as one the instance has only just
		// paid to build, which reclaim declines.
		const idleMin = over.idleMin ?? 10;
		await db.query(
			`INSERT INTO container_pool_members
			   (project_id, container_id, state, memory_bytes, has_unpushed_commits,
			    last_released_at, created_at)
			 VALUES ($1, $2, 'idle', $3, $4, now() - ($5 || ' minutes')::interval,
			         now() - ($6 || ' minutes')::interval)`,
			[
				project,
				containerId,
				CAP_BYTES,
				over.unpushed ?? false,
				idleMin,
				over.ageMin ?? Math.max(60, idleMin),
			],
		);
	}

	it('retires another project’s long-idle container rather than queueing', async () => {
		await emptyFleet();
		const donor = await freshProject('Reclaim Donor');
		const starved = await freshProject('Reclaim Starved');
		await seedIdle(donor, 'donor-idle');
		// Room for exactly one container, which the donor is holding.
		await setMaxContainerMemoryGb(db, 2);
		try {
			const acquired = await acquireRunContainer(deps(reclaimingDocker()), starved, TASK_STARVED);
			expect(acquired.containerId).not.toBe('donor-idle');
			// It was the donor's only container, so it is suspended rather than
			// destroyed: both free the same budget memory, and suspend leaves the
			// donor a ~1s resume instead of a full cold provision.
			expect(stopped).toContain('donor-idle');
			expect(removed).not.toContain('donor-idle');
			const left = await db.query<{ container_id: string; state: string }>(
				'SELECT container_id, state FROM container_pool_members WHERE project_id = $1',
				[donor],
			);
			expect(left.rows).toEqual([{ container_id: 'donor-idle', state: 'suspended' }]);
		} finally {
			await setMaxContainerMemoryGb(db, 40);
		}
	});

	it('destroys a donor’s surplus and keeps one resumable', async () => {
		await emptyFleet();
		const donor = await freshProject('Reclaim Surplus Donor');
		const starved = await freshProject('Reclaim Surplus Starved');
		await seedIdle(donor, 'donor-a');
		await seedIdle(donor, 'donor-b');
		// Room for two containers, both held by the donor.
		await setMaxContainerMemoryGb(db, 4);
		try {
			await acquireRunContainer(deps(reclaimingDocker()), starved, TASK_STARVED);
			// One container's worth covers the shortfall, and the donor still has
			// another, so that one is destroyed outright.
			expect(removed.length).toBe(1);
			expect(stopped).toEqual([]);
			const left = await db.query<{ c: number }>(
				`SELECT COUNT(*)::int AS c FROM container_pool_members
				  WHERE project_id = $1 AND state IN ('idle', 'suspended')`,
				[donor],
			);
			expect(left.rows[0].c).toBe(1);
		} finally {
			await setMaxContainerMemoryGb(db, 40);
		}
	});

	it('never reclaims a container the instance only just built', async () => {
		// The age floor, distinct from the idle one: this container has been idle
		// far longer than the idle window but was provisioned moments ago, so
		// retiring it would throw away a cold provision the instance just paid for.
		await emptyFleet();
		const donor = await freshProject('Reclaim Fresh Donor');
		const starved = await freshProject('Reclaim Fresh Starved');
		await seedIdle(donor, 'donor-brandnew', { idleMin: 10, ageMin: 1 });
		await setMaxContainerMemoryGb(db, 2);
		try {
			await expect(
				acquireRunContainer(deps(reclaimingDocker()), starved, TASK_STARVED),
			).rejects.toThrow(PoolCapacityError);
			expect(removed).not.toContain('donor-brandnew');
			expect(stopped).not.toContain('donor-brandnew');
		} finally {
			await setMaxContainerMemoryGb(db, 40);
		}
	});

	it('suspends rather than destroys a donor container holding unpushed commits', async () => {
		// Suspending frees the memory and keeps the only copy of the work.
		await emptyFleet();
		const donor = await freshProject('Reclaim Risky Donor');
		const starved = await freshProject('Reclaim Risky Starved');
		await seedIdle(donor, 'donor-risky', { unpushed: true });
		await setMaxContainerMemoryGb(db, 2);
		try {
			await acquireRunContainer(deps(reclaimingDocker()), starved, TASK_STARVED);
			expect(stopped).toContain('donor-risky');
			expect(removed).not.toContain('donor-risky');
		} finally {
			await setMaxContainerMemoryGb(db, 40);
		}
	});

	it('never reclaims a container that has only just gone idle', async () => {
		// A project releasing a container between two runs seconds apart is
		// mid-burst. Stripping it there makes both runs pay a cold start to hand
		// memory to a third project that would lose it the same way.
		await emptyFleet();
		const donor = await freshProject('Reclaim Fresh Donor');
		const starved = await freshProject('Reclaim Fresh Starved');
		await seedIdle(donor, 'donor-fresh', { idleMin: 0 });
		await setMaxContainerMemoryGb(db, 2);
		try {
			await expect(
				acquireRunContainer(deps(reclaimingDocker()), starved, TASK_STARVED),
			).rejects.toBeInstanceOf(PoolCapacityError);
			expect(removed).toEqual([]);
		} finally {
			await setMaxContainerMemoryGb(db, 40);
		}
	});

	it('reuses its own warm container rather than reclaiming somebody else’s', async () => {
		await emptyFleet();
		const donor = await freshProject('Reclaim Untouched Donor');
		const mine = await freshProject('Reclaim Self Server');
		await seedIdle(donor, 'donor-untouched');
		await seedIdle(mine, 'my-warm');
		await setMaxContainerMemoryGb(db, 2);
		try {
			const acquired = await acquireRunContainer(deps(reclaimingDocker()), mine, TASK_STARVED);
			expect(acquired.containerId).toBe('my-warm');
			expect(removed).toEqual([]);
		} finally {
			await setMaxContainerMemoryGb(db, 40);
		}
	});
});

/**
 * A container has to actually hold the cap it is handed a run against.
 *
 * The cap is forwarded correctly at create, but nothing recorded it and nothing
 * re-checked it, so raising a project's cap left its existing container in
 * service at the old allocation while everything downstream - the run's sizing,
 * the instance budget, the enforcement threshold, the exit-137 message and the
 * Containers page - read the new figure. On a managed sandbox that meant a
 * project set to 6 GB running in a 2 GB sandbox with nothing saying so.
 */
describe('acquireRunContainer against a changed memory cap', () => {
	async function memberAllocation(containerId: string): Promise<number | null> {
		const res = await db.query<{ memory_bytes: string | null }>(
			`SELECT memory_bytes FROM container_pool_members WHERE container_id = $1`,
			[containerId],
		);
		const raw = res.rows[0]?.memory_bytes;
		return raw === null || raw === undefined ? null : Number(raw);
	}

	function memoryRecordingDocker(): {
		docker: ContainerEngine;
		created: Array<number | undefined>;
		destroyed: string[];
	} {
		const created: Array<number | undefined> = [];
		const destroyed: string[] = [];
		const base = provisioningDocker();
		const docker = createStubDocker({
			...base,
			createContainer: vi.fn(async (_name: string, config: ContainerConfig) => {
				created.push(config.HostConfig.Memory);
				return { Id: `cap-cid-${seq++}`, Warnings: [] };
			}),
			removeContainer: vi.fn(async (id: string) => {
				destroyed.push(id);
			}),
			stopContainer: vi.fn(async () => {}),
		});
		return { docker, created, destroyed };
	}

	it('records the cap the container was provisioned to cover', async () => {
		const project = await freshProject('Cap Recorded');
		await db.query('UPDATE projects SET memory_limit_gib = 3 WHERE id = $1', [project]);
		const { docker, created } = memoryRecordingDocker();
		const acquired = await acquireRunContainer(deps(docker), project, null);
		try {
			expect(created).toEqual([3 * 1024 ** 3]);
			expect(await memberAllocation(acquired.containerId)).toBe(3 * 1024 ** 3);
		} finally {
			await acquired.release();
		}
	});

	it('replaces a container built for the old cap rather than reusing it', async () => {
		// The reported bug, end to end: a container provisioned at the default and a
		// cap raised afterwards. Reuse here is what handed a run 6 GB of budget and
		// a 2 GB container.
		const project = await freshProject('Cap Raised');
		await db.query('UPDATE projects SET memory_limit_gib = 2 WHERE id = $1', [project]);
		const { docker, created, destroyed } = memoryRecordingDocker();
		const first = await acquireRunContainer(deps(docker), project, null);
		const stale = first.containerId;
		await first.release();

		await db.query('UPDATE projects SET memory_limit_gib = 6 WHERE id = $1', [project]);
		const second = await acquireRunContainer(deps(docker), project, null);
		try {
			expect(second.containerId).not.toBe(stale);
			// Destroyed, not merely passed over: a member the ladder refuses still
			// counts against the instance budget until it is gone, so skipping it
			// would queue the replacement behind a container nothing can ever use.
			expect(destroyed).toContain(stale);
			expect(await memberAllocation(stale)).toBeNull();
			expect(created).toEqual([2 * 1024 ** 3, 6 * 1024 ** 3]);
			expect(await memberAllocation(second.containerId)).toBe(6 * 1024 ** 3);
		} finally {
			await second.release();
		}
	});

	it('replaces one built for more than the cap too', async () => {
		// It covers the cap, but a managed backend keeps billing for the larger
		// allocation the operator has since given back.
		const project = await freshProject('Cap Lowered');
		await db.query('UPDATE projects SET memory_limit_gib = 8 WHERE id = $1', [project]);
		const { docker, created, destroyed } = memoryRecordingDocker();
		const first = await acquireRunContainer(deps(docker), project, null);
		const large = first.containerId;
		await first.release();

		await db.query('UPDATE projects SET memory_limit_gib = 2 WHERE id = $1', [project]);
		const second = await acquireRunContainer(deps(docker), project, null);
		try {
			expect(destroyed).toContain(large);
			expect(created).toEqual([8 * 1024 ** 3, 2 * 1024 ** 3]);
		} finally {
			await second.release();
		}
	});

	it('replaces a member whose allocation was never recorded', async () => {
		// An adopted container, or one predating the column. Unknown is not a match:
		// guessing that it covers the cap is how a container ends up serving a run
		// it is too small for.
		const project = await freshProject('Cap Unknown');
		await db.query('UPDATE projects SET memory_limit_gib = 4 WHERE id = $1', [project]);
		const { docker, destroyed } = memoryRecordingDocker();
		const first = await acquireRunContainer(deps(docker), project, null);
		const adopted = first.containerId;
		await first.release();
		await db.query(
			`UPDATE container_pool_members SET memory_bytes = NULL WHERE container_id = $1`,
			[adopted],
		);

		const second = await acquireRunContainer(deps(docker), project, null);
		try {
			expect(second.containerId).not.toBe(adopted);
			expect(destroyed).toContain(adopted);
		} finally {
			await second.release();
		}
	});

	it('leaves a matching container alone, so an unchanged cap costs no cold start', async () => {
		const project = await freshProject('Cap Unchanged');
		await db.query('UPDATE projects SET memory_limit_gib = 4 WHERE id = $1', [project]);
		const { docker, created, destroyed } = memoryRecordingDocker();
		const first = await acquireRunContainer(deps(docker), project, null);
		await first.release();
		const second = await acquireRunContainer(deps(docker), project, null);
		try {
			expect(second.containerId).toBe(first.containerId);
			expect(destroyed).toEqual([]);
			expect(created.length).toBe(1);
		} finally {
			await second.release();
		}
	});

	it('reports what the container holds, not what the cap now says', async () => {
		// The Containers page read the project's cap, so it showed 6 GB beside a
		// container that had 2 - describing a container that did not exist.
		const project = await freshProject('Cap Listed');
		await db.query('UPDATE projects SET memory_limit_gib = 2 WHERE id = $1', [project]);
		const { docker } = memoryRecordingDocker();
		const acquired = await acquireRunContainer(deps(docker), project, null);
		try {
			await db.query('UPDATE projects SET memory_limit_gib = 6 WHERE id = $1', [project]);
			const listed = (await listAllContainers(db)).find(
				(c) => c.container_id === acquired.containerId,
			);
			expect(listed?.memory_bytes).toBe(2 * 1024 ** 3);
		} finally {
			await acquired.release();
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

	it('replaces its pinned container when the cap changes under it', async () => {
		// The pin is checked ahead of the ladder, so the allocation check has to be
		// repeated there or the chat is the one workload left running in a container
		// built for a cap nobody set any more.
		//
		// Its own project rather than the shared one: this case changes the cap, and
		// `chatProject()` hands back the *same* project every time (a team holds one
		// project), so the change would follow every case after it.
		const project = await freshProject('Chat Cap');
		await db.query('UPDATE projects SET memory_limit_gib = 2 WHERE id = $1', [project]);
		const docker = provisioningDocker();
		const first = await acquireRunContainer(deps(docker), project, null, 'chat');

		await db.query('UPDATE projects SET memory_limit_gib = 5 WHERE id = $1', [project]);
		const second = await acquireRunContainer(deps(docker), project, null, 'chat');
		expect(second.containerId).not.toBe(first.containerId);
		// Exactly one pin: the replacement is pinned and the stale container is gone
		// from the pool rather than left beside it.
		expect(await pinned(project)).toEqual([second.containerId]);
		expect(await poolRow(first.containerId)).toBeUndefined();
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
