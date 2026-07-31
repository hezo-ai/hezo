import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgliteDb } from '../src/db/drivers/pglite';
import {
	projectHasStrandedCommits,
	setPoolMemberUnpushedFlag,
} from '../src/services/sandbox/pool-db';
import { createTestDbWithMigrations } from './helpers/db';

/**
 * The unpushed-commit pin, written at every run end.
 *
 * The flag is what keeps `planIdleShutdown` off a container holding the only copy
 * of committed work, so the interesting behaviour is not that it can be set - it is
 * that an *unanswerable* check leaves it exactly as it was. Clearing a pin on "we
 * could not tell" would destroy the container the pin exists to protect.
 */
describe('setPoolMemberUnpushedFlag', () => {
	let db: PgliteDb;
	let projectId: string;
	let otherProjectId: string;

	const flagOf = async (containerId: string): Promise<boolean> => {
		const r = await db.query<{ has_unpushed_commits: boolean }>(
			'SELECT has_unpushed_commits FROM container_pool_members WHERE container_id = $1',
			[containerId],
		);
		return r.rows[0].has_unpushed_commits;
	};

	const seedProject = async (slug: string): Promise<string> => {
		// A team backs exactly one project (UNIQUE(projects.team_id)).
		const team = await db.query<{ id: string }>(
			'INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id',
			[`team-${slug}`],
		);
		const project = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix) VALUES ($1, $2, $2, $3) RETURNING id`,
			[team.rows[0].id, slug, slug.slice(0, 3).toUpperCase()],
		);
		return project.rows[0].id;
	};

	beforeAll(async () => {
		db = await createTestDbWithMigrations();
		projectId = await seedProject('pool');
		otherProjectId = await seedProject('other');
		await db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state)
			 VALUES ($1, 'ctr-a', 'idle'), ($1, 'ctr-b', 'idle'), ($2, 'ctr-c', 'idle')`,
			[projectId, otherProjectId],
		);
	});
	afterAll(() => db.close());

	it('pins a container that is holding stranded commits', async () => {
		await setPoolMemberUnpushedFlag(db, 'ctr-a', true);
		expect(await flagOf('ctr-a')).toBe(true);
	});

	it('leaves the pin alone when the check could not answer', async () => {
		// Null is not false. A git failure or a missing clone proves nothing, and
		// treating it as an all-clear would release a container that an earlier run
		// pinned for real.
		await setPoolMemberUnpushedFlag(db, 'ctr-a', null);
		expect(await flagOf('ctr-a')).toBe(true);
	});

	it('releases the pin on a definite all-clear', async () => {
		// The next run on the same container gets the commits out, so the pin must
		// clear - otherwise a single denied push pins a container forever.
		await setPoolMemberUnpushedFlag(db, 'ctr-a', false);
		expect(await flagOf('ctr-a')).toBe(false);
	});

	it('touches only the named container', async () => {
		await setPoolMemberUnpushedFlag(db, 'ctr-b', true);
		expect(await flagOf('ctr-a')).toBe(false);
		expect(await flagOf('ctr-c')).toBe(false);
	});

	it('writes nothing when the flag already holds that value', async () => {
		// Under MVCC a no-op UPDATE still leaves a dead tuple, and this runs at the
		// end of every run; the embedded backend has no autovacuum to reclaim it.
		const before = await db.query<{ updated_at: Date }>(
			'SELECT updated_at FROM container_pool_members WHERE container_id = $1',
			['ctr-b'],
		);
		await setPoolMemberUnpushedFlag(db, 'ctr-b', true);
		const after = await db.query<{ updated_at: Date }>(
			'SELECT updated_at FROM container_pool_members WHERE container_id = $1',
			['ctr-b'],
		);
		expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at);
	});

	it('is a no-op for a container with no pool member yet', async () => {
		// The pool table is populated as call sites move over; a run on a container
		// that has no member row must not throw at finalize.
		await expect(setPoolMemberUnpushedFlag(db, 'ctr-unknown', true)).resolves.toBeUndefined();
	});

	it('reports a project whose commits are stranded', async () => {
		expect(await projectHasStrandedCommits(db, projectId)).toBe(true);
		expect(await projectHasStrandedCommits(db, otherProjectId)).toBe(false);
	});

	it('stops reporting a project once its last pin clears', async () => {
		await setPoolMemberUnpushedFlag(db, 'ctr-b', false);
		expect(await projectHasStrandedCommits(db, projectId)).toBe(false);
	});
});
