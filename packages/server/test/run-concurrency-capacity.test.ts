import {
	ContainerStatus,
	computeDefaultMaxContainerMemoryGb,
	DEFAULT_CONTAINER_DISK_GB,
	DEFAULT_MAX_CONTAINER_MEMORY_GB,
	DEFAULT_RAM_CAP_PER_CONTAINER_GB,
	poolDiskCeilingBytes,
} from '@hezo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PgliteDb } from '../src/db/drivers/pglite';
import { MAX_CONTAINER_MEMORY_GB_KEY, setSystemMeta } from '../src/lib/system-meta';
import {
	getActiveContainers,
	isContainerCapacityBlockedInDb,
} from '../src/services/run-concurrency';
import { createStubDocker } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

/**
 * A stub engine so the budget resolves the same way it does in production: from
 * the engine's own memory answer, not a probe. These tests set the budget
 * explicitly, so only the shape of the call matters here.
 */
const engine = createStubDocker();

/** An engine whose containers run somewhere else - the managed-backend shape. */
const remoteEngine = createStubDocker({ containerHostMemory: () => null });

/**
 * The container-capacity gate, which is the instance's memory guarantee: every
 * container is memory-capped, so total demand is bounded at `N x cap`.
 *
 * That arithmetic is over **containers**. It was only ever equivalent to
 * counting projects-with-a-container while a project had exactly one, and the
 * pool breaks that equivalence - which is why the old "a project whose container
 * is already up is never blocked" shortcut had to go. These tests pin the two
 * halves of the replacement: what is counted, and who is exempt.
 */
describe('container capacity', () => {
	let db: PgliteDb;
	let n = 0;

	/** A project (with its own team - `UNIQUE(projects.team_id)` is 1:1). */
	async function seedProject(
		container: { id: string; status: ContainerStatus } | null = null,
	): Promise<string> {
		n += 1;
		const slug = `p${n}`;
		const team = await db.query<{ id: string }>(
			'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
			[`team-${slug}`],
		);
		const res = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, container_id, container_status)
			 VALUES ($1, $2, $2, $3, $4, $5::container_status) RETURNING id`,
			[team.rows[0].id, slug, slug.toUpperCase(), container?.id ?? null, container?.status ?? null],
		);
		return res.rows[0].id;
	}

	async function addMember(
		projectId: string,
		containerId: string,
		over: Partial<{
			state: string;
			reserved_for_chat: boolean;
			disk_used_bytes: number;
			disk_ceiling_bytes: number;
			memory_bytes: number | null;
		}> = {},
	): Promise<void> {
		await db.query(
			`INSERT INTO container_pool_members
			   (project_id, container_id, state, reserved_for_chat, disk_used_bytes,
			    disk_ceiling_bytes, memory_bytes)
			 VALUES ($1, $2, $3::container_pool_state, $4, $5, $6, $7)`,
			[
				projectId,
				containerId,
				over.state ?? 'idle',
				over.reserved_for_chat ?? false,
				over.disk_used_bytes ?? 0,
				over.disk_ceiling_bytes ?? poolDiskCeilingBytes(DEFAULT_CONTAINER_DISK_GB),
				over.memory_bytes === undefined ? 2 * 1024 ** 3 : over.memory_bytes,
			],
		);
	}

	beforeEach(async () => {
		db = await createTestDbWithMigrations();
		// Room for exactly two default-sized (2 GB) containers.
		await setSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY, '4');
	});
	afterEach(() => db.close());

	it('sums every container, not projects that have one', async () => {
		// The whole point of the change. One project holding two containers is two
		// containers' worth of memory; counting projects would report one and let
		// the instance run past its own ceiling.
		const project = await seedProject();
		await addMember(project, 'ctr-a');
		await addMember(project, 'ctr-b');
		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(4);
	});

	it('charges a container recorded in both representations exactly once', async () => {
		// Migration 049 is additive: `projects.container_*` stays authoritative
		// until every lifecycle call site moves over, so a container can be in both
		// places at once. Double-charging it would halve the effective budget.
		const project = await seedProject({ id: 'ctr-dup', status: ContainerStatus.Running });
		await addMember(project, 'ctr-dup');
		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(2);
	});

	it('charges nothing for the container reserved for the assistant chat', async () => {
		// The budget already holds one container's worth back for chat when it
		// computes the automatic default, and chat is exempt from queueing besides.
		// Charging it here too reserved the same memory twice, so an instance sized
		// for two containers would dispatch one whenever the chat was open.
		const project = await seedProject();
		await addMember(project, 'ctr-run', { state: 'busy' });
		await addMember(project, 'ctr-chat', { state: 'busy', reserved_for_chat: true });
		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(2);
	});

	it('does not charge for the chat container reached through the project row either', async () => {
		// `projects.container_id` is the other representation of the same container
		// (migration 049 is additive), so the exemption has to hold on both arms of
		// the UNION or the double-charge just moves.
		const project = await seedProject({ id: 'ctr-chat2', status: ContainerStatus.Running });
		await addMember(project, 'ctr-chat2', { state: 'busy', reserved_for_chat: true });
		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(0);
	});

	it('charges what a container was built with, not what the cap now says', async () => {
		// A container holds its allocation until the pool replaces it, so between a
		// cap being changed and the recycle the setting describes something that is
		// not running. Charging the new figure for a container still holding the old
		// one under-counts whenever the cap was lowered - the direction that
		// over-subscribes the host.
		const project = await seedProject();
		await addMember(project, 'ctr-big', { memory_bytes: 6 * 1024 ** 3 });
		await db.query('UPDATE projects SET memory_limit_gib = 1 WHERE id = $1', [project]);
		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(6);
	});

	it('falls back to the cap for a container whose allocation was never recorded', async () => {
		const project = await seedProject();
		await addMember(project, 'ctr-legacy', { memory_bytes: null });
		await db.query('UPDATE projects SET memory_limit_gib = 3 WHERE id = $1', [project]);
		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(3);
	});

	it('charges nothing for suspended and errored members, which cost storage rather than memory', async () => {
		const project = await seedProject();
		await addMember(project, 'ctr-idle');
		await addMember(project, 'ctr-susp', { state: 'suspended' });
		await addMember(project, 'ctr-err', { state: 'error' });
		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(2);
	});

	it('blocks a project whose only container is busy, once the cap is reached', async () => {
		// The removed shortcut, asserted as an exclusion. The project HAS a running
		// container, and under the old rule that alone waved it through - but the
		// container is serving a run, so a second concurrent run needs a second
		// container and must be gated like any other new start.
		const busy = await seedProject();
		await addMember(busy, 'ctr-busy', { state: 'busy' });
		const other = await seedProject();
		await addMember(other, 'ctr-other', { state: 'busy' });

		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(4);
		expect(await isContainerCapacityBlockedInDb(db, engine, busy)).toBe(true);
	});

	it('lets a project with a genuinely idle container through at the cap', async () => {
		// The narrower claim that replaces the shortcut: a container free to take
		// the run consumes no new slot, so the cap does not apply to it.
		const spare = await seedProject();
		await addMember(spare, 'ctr-idle');
		const other = await seedProject();
		await addMember(other, 'ctr-busy', { state: 'busy' });
		expect(await isContainerCapacityBlockedInDb(db, engine, spare)).toBe(false);
	});

	it('never counts the chat’s container as spare for a task run', async () => {
		// Chat is exempt from the cap; the pin is the other half of that. Treating
		// it as spare would let a task run take the container out from under a live
		// session, which is the same interruption by a different route.
		//
		// The two busy members elsewhere are what fill the budget: the chat member
		// is not charged against it (see above), so without them the project would
		// be unblocked because there is room, which would prove nothing about
		// whether its chat container counted as spare.
		const project = await seedProject();
		await addMember(project, 'ctr-chat', { reserved_for_chat: true });
		const other = await seedProject();
		await addMember(other, 'ctr-busy', { state: 'busy' });
		const third = await seedProject();
		await addMember(third, 'ctr-busy-2', { state: 'busy' });
		expect(await isContainerCapacityBlockedInDb(db, engine, project)).toBe(true);
	});

	it('never counts a container at its disk ceiling as spare', async () => {
		// It would fail its run partway through, which is worse than paying for a
		// fresh one.
		const project = await seedProject();
		await addMember(project, 'ctr-full', {
			disk_used_bytes: poolDiskCeilingBytes(DEFAULT_CONTAINER_DISK_GB),
		});
		const other = await seedProject();
		await addMember(other, 'ctr-busy', { state: 'busy' });
		expect(await isContainerCapacityBlockedInDb(db, engine, project)).toBe(true);
	});

	it('keeps today’s behaviour for a project with no pool members at all', async () => {
		// The migration is additive and the pool is populated per project as call
		// sites move over. Until a project has members, its running container is
		// still the one-container-per-project container, and a run in it consumes
		// no new slot - which is exactly what happens on a small local host today.
		const legacy = await seedProject({ id: 'ctr-legacy', status: ContainerStatus.Running });
		const a = await seedProject();
		await addMember(a, 'ctr-x', { state: 'busy' });
		const b = await seedProject();
		await addMember(b, 'ctr-y', { state: 'busy' });

		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(6);
		expect(await isContainerCapacityBlockedInDb(db, engine, legacy)).toBe(false);
	});

	it('blocks a project with nothing running once the cap is reached', async () => {
		const a = await seedProject();
		await addMember(a, 'ctr-1', { state: 'busy' });
		const b = await seedProject();
		await addMember(b, 'ctr-2', { state: 'busy' });
		const fresh = await seedProject();
		expect(await isContainerCapacityBlockedInDb(db, engine, fresh)).toBe(true);
	});

	it('admits a fresh project while the instance is under the cap', async () => {
		const a = await seedProject();
		await addMember(a, 'ctr-1', { state: 'busy' });
		const fresh = await seedProject();
		expect(await isContainerCapacityBlockedInDb(db, engine, fresh)).toBe(false);
	});

	it("charges a project's override rather than the default", async () => {
		// The reason capacity is a budget at all. Under a count this container was
		// one slot like any other, so an instance sized for 2 GB containers would
		// run three 4 GB ones and oversubscribe the host by double.
		const big = await seedProject();
		await db.query(`UPDATE projects SET memory_limit_gib = 4 WHERE id = $1`, [big]);
		// Provisioned under that override, which is what the charge follows - the
		// setting is only the fallback for a container that never recorded one.
		await addMember(big, 'ctr-big', { memory_bytes: 4 * 1024 ** 3 });
		expect((await getActiveContainers(db, engine)).usedMemoryGb).toBe(4);
	});

	it('blocks a large container that a half-empty budget still cannot fit', async () => {
		// The trade-off the budget accepts: a big container waits for enough
		// budget, not for any free slot. It is a delay rather than starvation
		// because a cap larger than the whole budget is refused where it is set.
		const small = await seedProject();
		await addMember(small, 'ctr-small'); // 2 GB of the 4 GB budget
		const big = await seedProject();
		await db.query(`UPDATE projects SET memory_limit_gib = 4 WHERE id = $1`, [big]);

		expect(await isContainerCapacityBlockedInDb(db, engine, big)).toBe(true);
		// …while a default-sized container fits in the same remaining 2 GB.
		const normal = await seedProject();
		expect(await isContainerCapacityBlockedInDb(db, engine, normal)).toBe(false);
	});
});

/**
 * Where the budget comes from when the operator has not set one. The engine is
 * asked rather than the host probed, so a backend whose containers run
 * elsewhere is not sized by the machine Hezo happens to be installed on.
 */
describe('automatic budget source', () => {
	let db: PgliteDb;

	beforeEach(async () => {
		db = await createTestDbWithMigrations();
	});
	afterEach(() => db.close());

	it('uses the flat default when the containers do not run on this host', async () => {
		const { budgetGb } = await getActiveContainers(db, remoteEngine);
		expect(budgetGb).toBe(DEFAULT_MAX_CONTAINER_MEMORY_GB);
	});

	it('derives from host memory when they do', async () => {
		const { budgetGb } = await getActiveContainers(db, engine);
		const host = engine.containerHostMemory();
		expect(host).not.toBeNull();
		expect(budgetGb).toBe(
			computeDefaultMaxContainerMemoryGb(host, DEFAULT_RAM_CAP_PER_CONTAINER_GB),
		);
	});

	it('an explicit setting wins on either backend', async () => {
		await setSystemMeta(db, MAX_CONTAINER_MEMORY_GB_KEY, '32');
		expect((await getActiveContainers(db, remoteEngine)).budgetGb).toBe(32);
		expect((await getActiveContainers(db, engine)).budgetGb).toBe(32);
	});
});
