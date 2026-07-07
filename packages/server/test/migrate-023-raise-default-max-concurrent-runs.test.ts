import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '023_raise_default_max_concurrent_runs.sql';

describe('023_raise_default_max_concurrent_runs migration', () => {
	let h: DataPreservationHarness;
	let defaultRowId: string;
	let customRowId: string;

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

		// A project on the old default (3) — inserted without specifying the column.
		const onDefault = await h.db.query<{ id: string; max_concurrent_runs: number }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Default', 'default', 'DEF') RETURNING id, max_concurrent_runs`,
			[await newTeam('team-default')],
		);
		defaultRowId = onDefault.rows[0].id;
		// Guard the premise: the pre-migration default really is 3.
		expect(onDefault.rows[0].max_concurrent_runs).toBe(3);

		// A project an operator explicitly customized away from the default.
		const custom = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, max_concurrent_runs)
			 VALUES ($1, 'Custom', 'custom', 'CUS', 5) RETURNING id`,
			[await newTeam('team-custom')],
		);
		customRowId = custom.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('changes the column default to 10 for new projects', async () => {
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('team-fresh', 'team-fresh') RETURNING id`,
		);
		const fresh = await h.db.query<{ max_concurrent_runs: number }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Fresh', 'fresh', 'FRE') RETURNING max_concurrent_runs`,
			[team.rows[0].id],
		);
		expect(fresh.rows[0].max_concurrent_runs).toBe(10);
	});

	it('bumps pre-existing projects on the old default (3) to 10', async () => {
		const row = await h.db.query<{ slug: string; max_concurrent_runs: number }>(
			`SELECT slug, max_concurrent_runs FROM projects WHERE id = $1`,
			[defaultRowId],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].slug).toBe('default');
		expect(row.rows[0].max_concurrent_runs).toBe(10);
	});

	it('preserves projects explicitly customized to another value', async () => {
		const row = await h.db.query<{ slug: string; max_concurrent_runs: number }>(
			`SELECT slug, max_concurrent_runs FROM projects WHERE id = $1`,
			[customRowId],
		);
		expect(row.rows).toHaveLength(1);
		expect(row.rows[0].slug).toBe('custom');
		expect(row.rows[0].max_concurrent_runs).toBe(5);
	});
});
