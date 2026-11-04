import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '086_project_container_hours_budget.sql';

/**
 * The migration gives every project an hours budget beside its token budget.
 * An existing project must come through with its token budget as it was and no
 * hours limit at all, or an upgrade would start holding work back for a limit
 * nobody set.
 */
describe('086_project_container_hours_budget migration', () => {
	let h: DataPreservationHarness;
	let projectId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ($1, $1) RETURNING id`,
			['team-hours-budget'],
		);
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix,
			                       daily_budget_tokens, weekly_budget_tokens, monthly_budget_tokens)
			 VALUES ($1, $2, $2, $3, 1000, 7000, 31000) RETURNING id`,
			[team.rows[0].id, 'hours-budget', 'HRB'],
		);
		projectId = project.rows[0].id;
		await h.db.query(
			`INSERT INTO container_uptime_entries
			   (project_id, container_id, started_at, ended_at, end_reason, backend)
			 VALUES ($1, 'ctr-closed', now() - interval '2 hours', now() - interval '1 hour', 'stopped', 'docker'),
			        ($1, 'ctr-open', now() - interval '20 minutes', NULL, NULL, 'docker')`,
			[projectId],
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('keeps the project and its token budget as they were', async () => {
		const row = await h.db.query<{
			name: string;
			daily_budget_tokens: string;
			weekly_budget_tokens: string;
			monthly_budget_tokens: string;
		}>(
			`SELECT name, daily_budget_tokens, weekly_budget_tokens, monthly_budget_tokens
			   FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(row.rows[0].name).toBe('hours-budget');
		expect(Number(row.rows[0].daily_budget_tokens)).toBe(1000);
		expect(Number(row.rows[0].weekly_budget_tokens)).toBe(7000);
		expect(Number(row.rows[0].monthly_budget_tokens)).toBe(31000);
	});

	it('gives an existing project no hours limit in any window', async () => {
		const row = await h.db.query<{
			daily_budget_container_seconds: string;
			weekly_budget_container_seconds: string;
			monthly_budget_container_seconds: string;
		}>(
			`SELECT daily_budget_container_seconds, weekly_budget_container_seconds,
			        monthly_budget_container_seconds
			   FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(Number(row.rows[0].daily_budget_container_seconds)).toBe(0);
		expect(Number(row.rows[0].weekly_budget_container_seconds)).toBe(0);
		expect(Number(row.rows[0].monthly_budget_container_seconds)).toBe(0);
	});

	it('keeps every uptime interval, open and closed', async () => {
		const rows = await h.db.query<{ container_id: string; open: boolean }>(
			`SELECT container_id, ended_at IS NULL AS open
			   FROM container_uptime_entries WHERE project_id = $1 ORDER BY container_id`,
			[projectId],
		);
		expect(rows.rows).toEqual([
			{ container_id: 'ctr-closed', open: false },
			{ container_id: 'ctr-open', open: true },
		]);
	});

	it('stores an hours limit and refuses a negative one', async () => {
		await h.db.query(
			`UPDATE projects SET daily_budget_container_seconds = 3600,
			                     weekly_budget_container_seconds = 25200
			  WHERE id = $1`,
			[projectId],
		);
		const stored = await h.db.query<{ daily: string; weekly: string }>(
			`SELECT daily_budget_container_seconds AS daily, weekly_budget_container_seconds AS weekly
			   FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(Number(stored.rows[0].daily)).toBe(3600);
		expect(Number(stored.rows[0].weekly)).toBe(25200);

		await expect(
			h.db.query(`UPDATE projects SET monthly_budget_container_seconds = -1 WHERE id = $1`, [
				projectId,
			]),
		).rejects.toThrow(/projects_budget_container_seconds_non_negative/);
	});

	it('indexes the per-project sum on the end of each interval', async () => {
		const idx = await h.db.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_container_uptime_project_end'`,
		);
		expect(idx.rows).toHaveLength(1);
		expect(idx.rows[0].indexdef).toContain('(project_id, ended_at)');
	});
});
