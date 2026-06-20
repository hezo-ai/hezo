import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// The Wire task header renders status / priority / assignee as quiet-tint badges
// (treatment A — colour-coded rounded pills, the design-system default) plus a
// mono runs · duration · cost summary derived from the task's runs + cost entries.
test('task header renders colour-coded status/priority pills + a runs/duration/cost summary', async () => {
	const ref = { projectSlug: '', taskId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Header Demo' });
			const agent = ws.agents[0];
			const task = await seedTask(ws, project, { title: 'Header task', assignee_id: agent.id });
			const db = getTestContext().db;
			// Pin a known status + priority so the colour-coded tints are deterministic.
			await db.query(
				`UPDATE tasks SET status='in_progress'::task_status, priority='high'::task_priority WHERE id=$1`,
				[task.id],
			);
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

	// Status is now a quiet-tint pill: the capitalized label on a rounded soft
	// background, not the raw lowercase enum in mono.
	const status = await findByTestId('task-status-inline');
	expect(status.textContent).toBe('In Progress');
	expect(status.className).toContain('rounded-full');
	expect(status.className).toContain('bg-warning-soft');
	expect(status.className).not.toContain('font-mono');

	// Priority is colour-coded too (high → warning tint).
	const priority = await findByTestId('task-priority-inline');
	expect(priority.textContent).toBe('high');
	expect(priority.className).toContain('bg-warning-soft');

	// Assignee carries no semantic state, so it renders as a neutral pill.
	const assignee = await findByTestId('task-assignee-inline');
	expect(assignee.className).toContain('rounded-full');
	expect(assignee.className).toContain('bg-neutral-soft');

	// The runs/duration/cost summary stays mono.
	const summary = await findByTestId('task-run-summary');
	expect(summary.textContent).toContain('1 run');
	expect(summary.textContent).toContain('41s');
	expect(summary.textContent).toContain('$1.86');
	expect(summary.className).toContain('font-mono');
});
