import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '049_container_pool.sql';

interface Seeded {
	running: string;
	stopped: string;
	errored: string;
	creating: string;
	noContainer: string;
}

/**
 * The migration is additive on purpose: an instance that upgrades keeps its
 * `projects.container_*` columns and keeps behaving exactly as it did, while
 * every existing container is carried forward as a single-member pool. That
 * carry-forward is what makes a small local host - one container per project -
 * indistinguishable from today after the pool lands, so it is the thing worth
 * asserting rather than "the table exists".
 */
describe('049_container_pool migration', () => {
	let h: DataPreservationHarness;
	let seeded: Seeded;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// A team backs exactly one project (UNIQUE(projects.team_id)), so each
		// fixture needs its own team.
		const project = async (
			slug: string,
			containerId: string | null,
			status: string | null,
			error: string | null = null,
		): Promise<string> => {
			const team = await h.db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
				[`team-${slug}`],
			);
			const res = await h.db.query<{ id: string }>(
				`INSERT INTO projects (team_id, name, slug, task_prefix, container_id, container_status, container_error)
				 VALUES ($1, $2, $2, $3, $4, $5::container_status, $6) RETURNING id`,
				[team.rows[0].id, slug, slug.slice(0, 3).toUpperCase(), containerId, status, error],
			);
			return res.rows[0].id;
		};

		seeded = {
			running: await project('running', 'ctr-running', 'running'),
			stopped: await project('stopped', 'ctr-stopped', 'stopped'),
			errored: await project('errored', 'ctr-errored', 'error', 'OOM killed'),
			creating: await project('creating', 'ctr-creating', 'creating'),
			noContainer: await project('none', null, null),
		};

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('creates the pool table with its capacity and selection indexes', async () => {
		const table = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.tables
			 WHERE table_name = 'container_pool_members'`,
		);
		expect(table.rows[0].c).toBe(1);

		const indexes = await h.db.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes WHERE tablename = 'container_pool_members'`,
		);
		const names = indexes.rows.map((r) => r.indexname);
		// Every recurring query ships with its index: one serves the per-project
		// acquire, the other the instance-wide capacity count.
		expect(names).toContain('idx_container_pool_members_project');
		expect(names).toContain('idx_container_pool_members_running');
	});

	it('carries every existing container forward as a single-member pool', async () => {
		// This is what keeps a small local host behaving exactly as it does now.
		const rows = await h.db.query<{ project_id: string; container_id: string; state: string }>(
			`SELECT project_id, container_id, state FROM container_pool_members ORDER BY container_id`,
		);
		expect(rows.rows.map((r) => r.container_id)).toEqual([
			'ctr-creating',
			'ctr-errored',
			'ctr-running',
			'ctr-stopped',
		]);
	});

	it('maps a running container to idle, not busy', async () => {
		// Boot fails every in-flight run and never reattaches, so by the time this
		// has applied nothing is genuinely serving a run. Marking it busy would
		// make the container permanently unavailable to the pool.
		const row = await h.db.query<{ state: string }>(
			`SELECT state FROM container_pool_members WHERE container_id = 'ctr-running'`,
		);
		expect(row.rows[0].state).toBe('idle');
	});

	it.each([
		['ctr-stopped', 'suspended'],
		['ctr-errored', 'error'],
		['ctr-creating', 'creating'],
	])('maps %s to %s', async (containerId, expected) => {
		const row = await h.db.query<{ state: string }>(
			`SELECT state FROM container_pool_members WHERE container_id = $1`,
			[containerId],
		);
		expect(row.rows[0].state).toBe(expected);
	});

	it('carries the error text forward rather than dropping it', async () => {
		// container_error is what the project page shows; losing it on upgrade
		// would silently blank a failure the operator has not yet seen.
		const row = await h.db.query<{ last_error: string | null }>(
			`SELECT last_error FROM container_pool_members WHERE container_id = 'ctr-errored'`,
		);
		expect(row.rows[0].last_error).toBe('OOM killed');
	});

	it('creates no member for a project that never had a container', async () => {
		const row = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM container_pool_members WHERE project_id = $1`,
			[seeded.noContainer],
		);
		expect(row.rows[0].c).toBe(0);
	});

	it('leaves the existing projects columns untouched, so nothing breaks mid-migration', async () => {
		// Additive by design: the call sites move over one at a time, and until
		// they have, they still read these.
		const row = await h.db.query<{ container_id: string; container_status: string }>(
			`SELECT container_id, container_status::text FROM projects WHERE id = $1`,
			[seeded.running],
		);
		expect(row.rows[0].container_id).toBe('ctr-running');
		expect(row.rows[0].container_status).toBe('running');
	});

	it('preserves every seeded project row', async () => {
		const row = await h.db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM projects`);
		expect(row.rows[0].c).toBe(Object.keys(seeded).length);
	});

	it('refuses two members claiming the same engine container', async () => {
		// A double-insert would otherwise produce two members that each believe
		// they own it, and the second run to arrive would share a container.
		await expect(
			h.db.query(
				`INSERT INTO container_pool_members (project_id, container_id) VALUES ($1, 'ctr-running')`,
				[seeded.stopped],
			),
		).rejects.toThrow();
	});

	it('drops a project’s members with the project', async () => {
		await h.db.query(`DELETE FROM projects WHERE id = $1`, [seeded.creating]);
		const row = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM container_pool_members WHERE container_id = 'ctr-creating'`,
		);
		expect(row.rows[0].c).toBe(0);
	});
});
