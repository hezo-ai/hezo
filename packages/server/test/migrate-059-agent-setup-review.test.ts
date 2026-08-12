import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '059_agent_setup_review.sql';

describe('059_agent_setup_review migration', () => {
	let h: DataPreservationHarness;
	let seededTeamId: string;
	let seededProjectId: string;
	let seededAgentId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		// Seed a representative established agent (plus the project it works in) at
		// the prior schema, so the ALTER has real rows to preserve.
		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		seededTeamId = team.rows[0].id;

		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, description)
			 VALUES ($1, 'Acme Web', 'acme-web', 'AW', 'The web project')
			 RETURNING id`,
			[seededTeamId],
		);
		seededProjectId = project.rows[0].id;
		await h.db.query('INSERT INTO project_task_counters (project_id, next_number) VALUES ($1, 1)', [
			seededProjectId,
		]);

		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent'::member_type, 'Engineer') RETURNING id`,
			[seededTeamId],
		);
		seededAgentId = member.rows[0].id;
		await h.db.query(
			`INSERT INTO member_agents (id, title, slug, role_description, summary, monthly_budget_cents)
			 VALUES ($1, 'Engineer', 'engineer', 'Builds things', 'An engineer.', 4200)`,
			[seededAgentId],
		);

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('preserves the pre-existing agent row', async () => {
		const r = await h.db.query<{
			title: string;
			slug: string;
			role_description: string;
			summary: string;
			monthly_budget_cents: number;
		}>(
			`SELECT title, slug, role_description, summary, monthly_budget_cents
			   FROM member_agents WHERE id = $1`,
			[seededAgentId],
		);
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].title).toBe('Engineer');
		expect(r.rows[0].slug).toBe('engineer');
		expect(r.rows[0].role_description).toBe('Builds things');
		expect(r.rows[0].summary).toBe('An engineer.');
		expect(Number(r.rows[0].monthly_budget_cents)).toBe(4200);
	});

	it('adds setup_review_task_id, null for every pre-existing agent', async () => {
		const r = await h.db.query<{ setup_review_task_id: string | null }>(
			'SELECT setup_review_task_id FROM member_agents WHERE id = $1',
			[seededAgentId],
		);
		expect(r.rows).toHaveLength(1);
		expect(r.rows[0].setup_review_task_id).toBeNull();
	});

	it('points at a task and nulls back out when that task is deleted', async () => {
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority)
			 VALUES ($1, $2, 1, 'AW-1', 'Set up the team',
			         'backlog'::task_status, 'high'::task_priority)
			 RETURNING id`,
			[seededTeamId, seededProjectId],
		);
		const taskId = task.rows[0].id;

		await h.db.query('UPDATE member_agents SET setup_review_task_id = $1 WHERE id = $2', [
			taskId,
			seededAgentId,
		]);
		const stamped = await h.db.query<{ setup_review_task_id: string | null }>(
			'SELECT setup_review_task_id FROM member_agents WHERE id = $1',
			[seededAgentId],
		);
		expect(stamped.rows[0].setup_review_task_id).toBe(taskId);

		// ON DELETE SET NULL: losing the review must never cascade the agent away.
		await h.db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
		const cleared = await h.db.query<{ setup_review_task_id: string | null }>(
			'SELECT setup_review_task_id FROM member_agents WHERE id = $1',
			[seededAgentId],
		);
		expect(cleared.rows).toHaveLength(1);
		expect(cleared.rows[0].setup_review_task_id).toBeNull();
	});
});
