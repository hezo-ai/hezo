import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// The Wire task header renders status / priority / assignee as inline mono
// metadata (not quiet-tint pills) with a runs · duration · cost summary derived
// from the task's runs + cost entries.
test('task header renders inline mono status + a runs/duration/cost summary', async () => {
	const ref = { projectSlug: '', taskId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Header Demo' });
			const agent = ws.agents[0];
			const task = await seedTask(ws, project, { title: 'Header task', assignee_id: agent.id });
			const db = getTestContext().db;
			// One finished 41s run + a $1.86 cost entry (cost_entries has no team_id since 004).
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
				 VALUES ($1,$2,$3,'succeeded'::heartbeat_run_status,'2026-01-01T00:00:00Z','2026-01-01T00:00:41Z')`,
				[agent.id, ws.team.id, task.id],
			);
			await db.query(
				`INSERT INTO cost_entries (member_id, task_id, project_id, amount_cents)
				 VALUES ($1,$2,$3,186)`,
				[agent.id, task.id, project.id],
			);
			ref.projectSlug = project.slug;
			ref.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ref.projectSlug, taskId: ref.taskId },
	});

	// Status is the raw lowercase enum in mono — not the capitalized quiet-tint pill.
	const status = await findByTestId('task-status-inline');
	expect(status.textContent).toMatch(/^[a-z_]+$/);
	expect(status.parentElement?.className ?? '').toContain('font-mono');

	const summary = await findByTestId('task-run-summary');
	expect(summary.textContent).toContain('1 run');
	expect(summary.textContent).toContain('41s');
	expect(summary.textContent).toContain('$1.86');
});
