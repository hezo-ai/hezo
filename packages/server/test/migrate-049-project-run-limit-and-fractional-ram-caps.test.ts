import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '049_project_run_limit_and_fractional_ram_caps.sql';

describe('049_project_run_limit_and_fractional_ram_caps migration', () => {
	let h: DataPreservationHarness;
	let cappedProjectId: string;
	let inheritProjectId: string;
	let runId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// projects.team_id is UNIQUE (1:1 team↔project), so each project needs its own team.
		const newTeam = async (slug: string): Promise<string> => {
			const t = await h.db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
				[slug],
			);
			return t.rows[0].id;
		};

		// A project with an operator-set integer memory cap: the INTEGER ->
		// DOUBLE PRECISION widen must carry it over exactly.
		const cappedTeamId = await newTeam('team-capped');
		const capped = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, memory_limit_gib, container_id, container_status)
			 VALUES ($1, 'Capped', 'capped', 'CAP', 8, 'cid-capped', 'running') RETURNING id`,
			[cappedTeamId],
		);
		cappedProjectId = capped.rows[0].id;

		// A project on the inherit default (NULL since 048) - must stay NULL.
		const inherit = await h.db.query<{ id: string; memory_limit_gib: number | null }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Inherit', 'inherit', 'INH') RETURNING id, memory_limit_gib`,
			[await newTeam('team-inherit')],
		);
		inheritProjectId = inherit.rows[0].id;
		// Guard the premise: post-048 there is no memory default, so this is NULL.
		expect(inherit.rows[0].memory_limit_gib).toBeNull();

		// A run, so the projects table reshape is shown not to disturb run history.
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Agent') RETURNING id`,
			[cappedTeamId],
		);
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'CAP-1', 'Task') RETURNING id`,
			[cappedTeamId, cappedProjectId],
		);
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
			 VALUES ($1, $2, $3, 'running') RETURNING id`,
			[cappedTeamId, member.rows[0].id, task.rows[0].id],
		);
		runId = run.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds a nullable max_concurrent_runs with no default', async () => {
		const col = await h.db.query<{
			data_type: string;
			is_nullable: string;
			column_default: string | null;
		}>(
			`SELECT data_type, is_nullable, column_default FROM information_schema.columns
			 WHERE table_name = 'projects' AND column_name = 'max_concurrent_runs'`,
		);
		expect(col.rows[0]).toMatchObject({
			data_type: 'integer',
			is_nullable: 'YES',
			column_default: null,
		});
	});

	it('leaves pre-existing projects inheriting the global run limit', async () => {
		const rows = await h.db.query<{ id: string; max_concurrent_runs: number | null }>(
			`SELECT id, max_concurrent_runs FROM projects WHERE id = ANY($1::uuid[])`,
			[[cappedProjectId, inheritProjectId]],
		);
		expect(rows.rows).toHaveLength(2);
		for (const row of rows.rows) expect(row.max_concurrent_runs).toBeNull();
	});

	it('rejects a run limit below 1', async () => {
		await expect(
			h.db.query(`UPDATE projects SET max_concurrent_runs = 0 WHERE id = $1`, [cappedProjectId]),
		).rejects.toThrow();
	});

	it('widens memory_limit_gib to double precision, preserving both values exactly', async () => {
		const col = await h.db.query<{ data_type: string; is_nullable: string }>(
			`SELECT data_type, is_nullable FROM information_schema.columns
			 WHERE table_name = 'projects' AND column_name = 'memory_limit_gib'`,
		);
		expect(col.rows[0]).toMatchObject({ data_type: 'double precision', is_nullable: 'YES' });

		const rows = await h.db.query<{ id: string; memory_limit_gib: number | null }>(
			`SELECT id, memory_limit_gib FROM projects WHERE id = ANY($1::uuid[])`,
			[[cappedProjectId, inheritProjectId]],
		);
		const byId = new Map(rows.rows.map((r) => [r.id, r.memory_limit_gib]));
		expect(byId.get(cappedProjectId)).toBe(8); // explicit override carried over
		expect(byId.get(inheritProjectId)).toBeNull(); // inherit stays inherit
	});

	it('accepts a fractional cap and returns it as a JS number, not a string', async () => {
		const updated = await h.db.query<{ memory_limit_gib: number | null }>(
			`UPDATE projects SET memory_limit_gib = 0.5 WHERE id = $1 RETURNING memory_limit_gib`,
			[cappedProjectId],
		);
		// The assertion that would have caught a NUMERIC column: services/containers.ts
		// multiplies this value by 1024**3 to build the Docker cgroup limit.
		expect(updated.rows[0].memory_limit_gib).toBe(0.5);
		expect(typeof updated.rows[0].memory_limit_gib).toBe('number');

		const tenth = await h.db.query<{ memory_limit_gib: number | null }>(
			`UPDATE projects SET memory_limit_gib = 2.5 WHERE id = $1 RETURNING memory_limit_gib`,
			[cappedProjectId],
		);
		expect(tenth.rows[0].memory_limit_gib).toBe(2.5);
	});

	it('still enforces a floor, now at 0.5 rather than 1', async () => {
		await expect(
			h.db.query(`UPDATE projects SET memory_limit_gib = 0.4 WHERE id = $1`, [inheritProjectId]),
		).rejects.toThrow();
		// The old floor of 1 must no longer reject: 0.6 is valid now.
		const ok = await h.db.query<{ memory_limit_gib: number | null }>(
			`UPDATE projects SET memory_limit_gib = 0.6 WHERE id = $1 RETURNING memory_limit_gib`,
			[inheritProjectId],
		);
		expect(ok.rows[0].memory_limit_gib).toBe(0.6);
	});

	it('preserves pre-existing project and run rows', async () => {
		const projects = await h.db.query<{ slug: string; container_id: string | null }>(
			`SELECT slug, container_id FROM projects WHERE id = ANY($1::uuid[]) ORDER BY slug`,
			[[cappedProjectId, inheritProjectId]],
		);
		expect(projects.rows).toHaveLength(2);
		expect(projects.rows[0]).toMatchObject({ slug: 'capped', container_id: 'cid-capped' });
		expect(projects.rows[1]).toMatchObject({ slug: 'inherit', container_id: null });

		const run = await h.db.query<{ status: string }>(
			`SELECT status FROM heartbeat_runs WHERE id = $1`,
			[runId],
		);
		expect(run.rows[0]?.status).toBe('running');
	});
});
