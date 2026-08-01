import { ContainerStatus } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgliteDb } from '../src/db/drivers/pglite';
import { reapOrphanedContainers } from '../src/services/sandbox/orphan-reaper';
import {
	listReferencedContainerIds,
	reclaimBusyPoolMembers,
} from '../src/services/sandbox/pool-db';
import { createStubDocker } from './helpers/app';
import { createTestDbWithMigrations } from './helpers/db';

/**
 * The orphan sweep's live set, against a real schema.
 *
 * This is the layer the sweep was wrong at, and the layer nothing covered: the
 * reaper itself is pure and was always handed a correct set by its unit tests,
 * while the caller built that set from `projects` alone. A pooled project owns
 * several containers at once and the project row names only the newest, so
 * everything else - a container running someone's work, a suspended member, one
 * pinned for unpushed commits - read as unreferenced and was force-destroyed on
 * a ten-minute cron.
 */
describe('listReferencedContainerIds', () => {
	let db: PgliteDb;
	let projectId: string;

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		// A team backs exactly one project (UNIQUE(projects.team_id)).
		const team = await db.query<{ id: string }>(
			'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
			['team-pool'],
		);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, container_id, container_status)
			 VALUES ($1, 'pool', 'pool', 'POO', 'ctr-newest', $2::container_status) RETURNING id`,
			[team.rows[0].id, ContainerStatus.Running],
		);
		projectId = project.rows[0].id;
		// The newest container is the one the project row names; the rest are the
		// pool members that row cannot see.
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state)
			 VALUES ($1, 'ctr-newest', 'idle'),
			        ($1, 'ctr-busy', 'busy'),
			        ($1, 'ctr-suspended', 'suspended'),
			        ($1, 'ctr-pinned', 'idle')`,
			[projectId],
		);
		await db.query(
			`UPDATE container_pool_members SET has_unpushed_commits = true WHERE container_id = 'ctr-pinned'`,
		);
	});
	afterAll(() => db.close());

	it('carries every pool member, whatever its state', async () => {
		const live = await listReferencedContainerIds(db);
		// `suspended` most of all: it is the state a container the pool means to
		// resume sits in, so destroying one is silent loss of its filesystem.
		expect([...live].sort()).toEqual(['ctr-busy', 'ctr-newest', 'ctr-pinned', 'ctr-suspended']);
	});

	it('counts a container recorded in both representations once', async () => {
		const live = await listReferencedContainerIds(db);
		expect([...live].filter((id) => id === 'ctr-newest')).toHaveLength(1);
	});

	it('leaves a genuinely unreferenced container out', async () => {
		const live = await listReferencedContainerIds(db);
		expect(live.has('ctr-orphan')).toBe(false);
	});

	it('spares every live container end to end, and still reaps the orphan', async () => {
		// The sweep as the cron actually runs it: the engine reports everything this
		// instance owns, and only the container no representation names is destroyed.
		const destroyed: string[] = [];
		const owned = ['ctr-newest', 'ctr-busy', 'ctr-suspended', 'ctr-pinned', 'ctr-orphan'];
		const engine = createStubDocker({
			listContainersByLabel: async () => owned.map((id) => ({ Id: id, Names: [`/${id}`] })),
			removeContainer: async (id: string) => {
				destroyed.push(id);
			},
		});

		const live = await listReferencedContainerIds(db);
		const first = await reapOrphanedContainers(engine, 'inst-1', live);
		// Nothing dies on a first sighting.
		expect(destroyed).toEqual([]);
		const second = await reapOrphanedContainers(engine, 'inst-1', live, first.suspected);
		expect(destroyed).toEqual(['ctr-orphan']);
		expect(second.destroyed).toEqual(['ctr-orphan']);
	});
});

/**
 * Boot fails every in-flight run and never reattaches, so a member still marked
 * busy is holding a claim for a run that no longer exists. Nothing else clears
 * one - the ladder skips a busy member and the idle pass only touches idle ones -
 * so a claim leaked across a crash costs that container permanently while its
 * memory keeps counting against the instance budget.
 */
describe('reclaimBusyPoolMembers', () => {
	let db: PgliteDb;

	const stateOf = async (containerId: string): Promise<string> => {
		const r = await db.query<{ state: string }>(
			`SELECT state::text AS state FROM container_pool_members WHERE container_id = $1`,
			[containerId],
		);
		return r.rows[0].state;
	};

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		const team = await db.query<{ id: string }>(
			'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
			['team-reclaim'],
		);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'reclaim', 'reclaim', 'REC') RETURNING id`,
			[team.rows[0].id],
		);
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state)
			 VALUES ($1, 'ctr-claimed', 'busy'),
			        ($1, 'ctr-warm', 'idle'),
			        ($1, 'ctr-parked', 'suspended')`,
			[project.rows[0].id],
		);
	});
	afterAll(() => db.close());

	it('returns a claimed member to the pool', async () => {
		expect(await reclaimBusyPoolMembers(db)).toEqual(['ctr-claimed']);
		expect(await stateOf('ctr-claimed')).toBe('idle');
	});

	it('leaves a suspended member suspended', async () => {
		// Something stopped that container deliberately. Advertising it as idle
		// would hand a run a container that is not running.
		expect(await stateOf('ctr-parked')).toBe('suspended');
	});

	it('is a no-op when nothing is claimed', async () => {
		expect(await reclaimBusyPoolMembers(db)).toEqual([]);
		expect(await stateOf('ctr-warm')).toBe('idle');
	});
});
