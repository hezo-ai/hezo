import { DEFAULT_CONTAINER_DISK_GB, poolDiskCeilingBytes } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '050_container_pool.sql';

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
describe('050_container_pool migration', () => {
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

/**
 * A chat session survives its container being suspended.
 *
 * The interesting part is the singleton guard, not the enum value: a suspended
 * session still owns its row and its container, so it has to keep blocking a
 * second session the way a running one does. Stating the predicate as "not
 * terminal" is what makes that true without naming the new value - which the
 * same transaction could not use anyway.
 */
describe('050_container_pool migration: chat session suspend', () => {
	let h: DataPreservationHarness;
	let memberId: string;
	let otherMemberId: string;
	let teamId: string;
	let projectId: string;
	let runningSessionId: string;
	let stoppedSessionId: string;

	const insertSession = async (member: string, status: string): Promise<string> => {
		const r = await h.db.query<{ id: string }>(
			`INSERT INTO chat_sessions (member_id, team_id, project_id, container_id, runtime_type, status)
			 VALUES ($1, $2, $3, 'ctr-chat', 'claude_code', $4::chat_session_status) RETURNING id`,
			[member, teamId, projectId, status],
		);
		return r.rows[0].id;
	};

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('HQ', 'hq') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, is_internal)
			 VALUES ($1, 'HQ', 'hq', 'HQ', true) RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const member = async (name: string): Promise<string> => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO members (team_id, display_name, member_type) VALUES ($1, $2, 'agent') RETURNING id`,
				[teamId, name],
			);
			return r.rows[0].id;
		};
		memberId = await member('CEO');
		otherMemberId = await member('Coach');

		runningSessionId = await insertSession(memberId, 'running');
		stoppedSessionId = await insertSession(otherMemberId, 'stopped');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the suspended status', async () => {
		const r = await h.db.query<{ label: string }>(
			`SELECT e.enumlabel AS label FROM pg_enum e
			 JOIN pg_type t ON t.oid = e.enumtypid
			 WHERE t.typname = 'chat_session_status' ORDER BY e.enumsortorder`,
		);
		expect(r.rows.map((row) => row.label)).toEqual([
			'starting',
			'running',
			'crashed',
			'stopped',
			'suspended',
		]);
	});

	it('preserves the pre-existing sessions and their statuses', async () => {
		const r = await h.db.query<{ id: string; status: string }>(
			'SELECT id, status::text FROM chat_sessions ORDER BY status',
		);
		expect(r.rows).toEqual([
			{ id: runningSessionId, status: 'running' },
			{ id: stoppedSessionId, status: 'stopped' },
		]);
	});

	it('lets an existing session move to suspended', async () => {
		await h.db.query(
			`UPDATE chat_sessions SET status = 'suspended'::chat_session_status WHERE id = $1`,
			[runningSessionId],
		);
		const r = await h.db.query<{ status: string }>(
			'SELECT status::text FROM chat_sessions WHERE id = $1',
			[runningSessionId],
		);
		expect(r.rows[0].status).toBe('suspended');
	});

	it('counts a suspended session as live in the singleton guard', async () => {
		// It still owns its row and its container; a second session alongside it
		// would give the operator two chats racing the same container.
		await expect(insertSession(memberId, 'starting')).rejects.toThrow();
	});

	it('still allows a fresh session once the previous one ended', async () => {
		await h.db.query(
			`UPDATE chat_sessions SET status = 'stopped'::chat_session_status WHERE id = $1`,
			[runningSessionId],
		);
		const fresh = await insertSession(memberId, 'starting');
		expect(fresh).toBeTruthy();
		// And the guard still holds against the new one.
		await expect(insertSession(memberId, 'running')).rejects.toThrow();
	});
});

describe('050_container_memory_budget migration', () => {
	let h: DataPreservationHarness;

	const meta = async (key: string): Promise<string | null> => {
		const r = await h.db.query<{ value: string }>(`SELECT value FROM system_meta WHERE key = $1`, [
			key,
		]);
		return r.rows[0]?.value ?? null;
	};

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);
		await h.db.query(
			`INSERT INTO system_meta (key, value) VALUES
			   ('max_active_containers', '3'),
			   ('default_ram_cap_per_container_gb', '4'),
			   ('container_idle_timeout_min', '45'),
			   ('instance_locale', 'de')`,
		);
		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('converts an explicit container count into the equivalent memory budget', async () => {
		// 3 containers x 4 GB each is the same fleet, expressed in the new unit.
		expect(await meta('max_container_memory_gb')).toBe('12');
	});

	it('removes the superseded key so no stale number looks authoritative', async () => {
		expect(await meta('max_active_containers')).toBeNull();
	});

	it('drops the container idle timeout, which is now a constant', async () => {
		// Nothing to carry it forward to, deliberately: the window is
		// `CONTAINER_IDLE_TIMEOUT_MIN` now, and a stored number nothing reads is
		// worse than no row - it sits in the settings table looking authoritative.
		expect(await meta('container_idle_timeout_min')).toBeNull();
	});

	it('leaves the per-container cap and unrelated settings untouched', async () => {
		expect(await meta('default_ram_cap_per_container_gb')).toBe('4');
		expect(await meta('instance_locale')).toBe('de');
	});
});

describe('050_container_memory_budget migration on an instance that never set a cap', () => {
	let h: DataPreservationHarness;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);
		await h.db.query(`INSERT INTO system_meta (key, value) VALUES ('instance_locale', 'fr')`);
		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('writes no budget, so the computed default keeps applying', async () => {
		// Storing one here would freeze today's host memory into the settings
		// table, so an instance that later gains RAM would never notice.
		const r = await h.db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM system_meta WHERE key = 'max_container_memory_gb'`,
		);
		expect(r.rows[0].n).toBe(0);
	});

	it('preserves the settings that were there', async () => {
		const r = await h.db.query<{ value: string }>(
			`SELECT value FROM system_meta WHERE key = 'instance_locale'`,
		);
		expect(r.rows[0].value).toBe('fr');
	});
});

describe('051_container_disk_size migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;
	let memberId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, memory_limit_gib)
			 VALUES ($1, 'Web', 'web', 'WEB', 4) RETURNING id`,
			[team.rows[0].id],
		);
		projectId = project.rows[0].id;

		await h.applyTarget(TARGET);

		// The pool table is created by this same migration, so there is no
		// "member at the prior schema" to preserve - what matters instead is the
		// ceiling a member gets when the provisioning code does not name one.
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO container_pool_members (project_id, container_id, state, disk_used_bytes)
			 VALUES ($1, 'ctr-existing', 'idle'::container_pool_state, 1073741824) RETURNING id`,
			[projectId],
		);
		memberId = member.rows[0].id;
	});
	afterAll(() => h.close());

	it('adds the per-project override, defaulting to inherit', async () => {
		const row = await h.db.query<{ container_disk_gb: number | null }>(
			'SELECT container_disk_gb FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows.length).toBe(1);
		// NULL, not the default value: a project that never chose one must keep
		// following the instance setting when the operator changes it.
		expect(row.rows[0].container_disk_gb).toBeNull();
	});

	it('accepts an override and refuses one below the floor', async () => {
		await h.db.query('UPDATE projects SET container_disk_gb = 8 WHERE id = $1', [projectId]);
		const row = await h.db.query<{ container_disk_gb: number }>(
			'SELECT container_disk_gb FROM projects WHERE id = $1',
			[projectId],
		);
		expect(row.rows[0].container_disk_gb).toBe(8);

		await expect(
			h.db.query('UPDATE projects SET container_disk_gb = 1 WHERE id = $1', [projectId]),
		).rejects.toThrow();
		// The rejected write left the accepted one intact.
		const after = await h.db.query<{ container_disk_gb: number }>(
			'SELECT container_disk_gb FROM projects WHERE id = $1',
			[projectId],
		);
		expect(after.rows[0].container_disk_gb).toBe(8);
	});

	it('gives a member that names no ceiling the conservative 2 GiB default', async () => {
		const row = await h.db.query<{
			container_id: string;
			disk_used_bytes: string;
			disk_ceiling_bytes: string;
		}>(
			'SELECT container_id, disk_used_bytes, disk_ceiling_bytes FROM container_pool_members WHERE id = $1',
			[memberId],
		);
		expect(row.rows.length).toBe(1);
		expect(row.rows[0].container_id).toBe('ctr-existing');
		expect(Number(row.rows[0].disk_used_bytes)).toBe(1073741824);
		// The column default, deliberately below what a newly-provisioned container
		// is given: a member whose ceiling was never set must be judged against the
		// smallest allocation it could plausibly have, never a larger one it may
		// not actually have been given.
		expect(Number(row.rows[0].disk_ceiling_bytes)).toBe(2 * 1024 ** 3);
	});

	it('leaves the new default meaningfully below the allocation', async () => {
		// The property the ceiling exists for: a container is recycled with room to
		// spare, so a run never discovers the wall partway through.
		const ceiling = poolDiskCeilingBytes(DEFAULT_CONTAINER_DISK_GB);
		expect(ceiling).toBeLessThan(DEFAULT_CONTAINER_DISK_GB * 1024 ** 3);
		expect(ceiling).toBeGreaterThan(0);
	});
});

describe('049_container_pool run-to-container attribution', () => {
	let h: DataPreservationHarness;
	let runId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// A run recorded at the prior schema, i.e. before runs knew their
		// container. It must survive and read as unattributable rather than as
		// belonging to some container it never ran in.
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('attr', 'attr') RETURNING id`,
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'attr', 'attr', 'ATT') RETURNING id`,
			[team.rows[0].id],
		);
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name) VALUES ($1, 'agent', 'attr') RETURNING id`,
			[team.rows[0].id],
		);
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (project_id, team_id, number, identifier, title, created_by_member_id)
			 VALUES ($1, $2, 1, 'ATT-1', 'pre-existing', $3) RETURNING id`,
			[project.rows[0].id, team.rows[0].id, member.rows[0].id],
		);
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now()) RETURNING id`,
			[member.rows[0].id, team.rows[0].id, task.rows[0].id],
		);
		runId = run.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the column runs are attributed by', async () => {
		const c = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			  WHERE table_name = 'heartbeat_runs' AND column_name = 'container_id'`,
		);
		expect(c.rows[0].c).toBe(1);
	});

	it('indexes the predicate the container-death path asks', async () => {
		// Without it, every container death scans heartbeat_runs - a table that
		// only grows - on a path that fires per container per lifetime.
		const idx = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM pg_indexes
			  WHERE tablename = 'heartbeat_runs' AND indexname = 'idx_runs_container_live'`,
		);
		expect(idx.rows[0].c).toBe(1);
	});

	it('preserves the pre-existing run, leaving it unattributed', async () => {
		// NULL is "cannot attribute", which the death path treats as in-scope -
		// the safe direction, since nothing can prove such a run is still alive.
		const r = await h.db.query<{ status: string; container_id: string | null }>(
			`SELECT status::text AS status, container_id FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(r.rows.length).toBe(1);
		expect(r.rows[0].status).toBe('running');
		expect(r.rows[0].container_id).toBeNull();
	});
});
