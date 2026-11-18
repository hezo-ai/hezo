import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '087_container_stranded_work.sql';

/**
 * The migration moves the stranded-commit pin from one flag per container to one
 * row per clone and branch. An instance upgrading onto it must release nothing:
 * a container pinned before the upgrade holds the only copy of someone's commits,
 * and nothing recorded which branch they are on, so it is carried across as a
 * row of unknown cause that no run can clear.
 */
describe('087_container_stranded_work migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;
	let taskId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
			['team-stranded-work'],
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, $2, $2, $3) RETURNING id`,
			[team.rows[0].id, 'stranded-work', 'STW'],
		);
		projectId = project.rows[0].id;
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title)
			 VALUES ($1, $2, 1, 'STW-1', 'Stranded work') RETURNING id`,
			[team.rows[0].id, projectId],
		);
		taskId = task.rows[0].id;

		await h.db.query(
			`INSERT INTO container_pool_members
			   (project_id, container_id, state, last_task_id, has_unpushed_commits)
			 VALUES ($1, 'ctr-pinned', 'suspended', $2, true),
			        ($1, 'ctr-free', 'idle', $2, false)`,
			[projectId, taskId],
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves every pool member, its state and its pin', async () => {
		const rows = await h.db.query<{
			container_id: string;
			state: string;
			last_task_id: string;
			has_unpushed_commits: boolean;
		}>(
			`SELECT container_id, state::text AS state, last_task_id, has_unpushed_commits
			   FROM container_pool_members WHERE project_id = $1 ORDER BY container_id`,
			[projectId],
		);
		expect(rows.rows).toEqual([
			{
				container_id: 'ctr-free',
				state: 'idle',
				last_task_id: taskId,
				has_unpushed_commits: false,
			},
			{
				container_id: 'ctr-pinned',
				state: 'suspended',
				last_task_id: taskId,
				has_unpushed_commits: true,
			},
		]);
	});

	it('carries each existing pin across as a row of unknown cause', async () => {
		const rows = await h.db.query<{
			container_id: string;
			task_id: string | null;
			repo_name: string | null;
			branch: string | null;
		}>(
			`SELECT container_id, task_id, repo_name, branch FROM container_stranded_work
			  ORDER BY container_id`,
		);
		// Not attributed to the last task: that is often not the task whose
		// commits pinned the container, and its next clean run would release it.
		expect(rows.rows).toEqual([
			{ container_id: 'ctr-pinned', task_id: null, repo_name: null, branch: null },
		]);
	});

	it('records a branch pin and refuses a half-known cause', async () => {
		await h.db.query(
			`INSERT INTO container_stranded_work (container_id, task_id, repo_name, branch)
			 VALUES ('ctr-free', $1, 'app', 'hezo/STW-1')`,
			[taskId],
		);
		await expect(
			h.db.query(
				`INSERT INTO container_stranded_work (container_id, repo_name)
				 VALUES ('ctr-free', 'app')`,
			),
		).rejects.toThrow();
		await expect(
			h.db.query(
				`INSERT INTO container_stranded_work (container_id, task_id, repo_name, branch)
				 VALUES ('ctr-free', $1, 'app', 'hezo/STW-1')`,
				[taskId],
			),
		).rejects.toThrow();
	});

	it('drops the rows of a removed container', async () => {
		await h.db.query(`DELETE FROM container_pool_members WHERE container_id = 'ctr-free'`);
		const rows = await h.db.query(
			`SELECT 1 FROM container_stranded_work WHERE container_id = 'ctr-free'`,
		);
		expect(rows.rows).toEqual([]);
	});
});
