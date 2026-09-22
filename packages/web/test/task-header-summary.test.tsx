import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// The Wire task header renders status / priority / assignee as quiet-tint badges
// (treatment A — colour-coded rounded pills, the design-system default) plus a
// mono runs · duration · tokens summary derived from the task's runs + usage entries.
test('task header renders colour-coded status/priority pills + a runs/duration/tokens summary', async () => {
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
			// One finished 41s run + a usage entry of 1.9M tokens.
			await db.query(
				`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
				 VALUES ($1,$2,$3,'succeeded'::heartbeat_run_status,'2026-01-01T00:00:00Z','2026-01-01T00:00:41Z')`,
				[agent.id, ws.team.id, task.id],
			);
			await db.query(
				`INSERT INTO usage_entries (member_id, task_id, project_id, input_tokens, output_tokens)
				 VALUES ($1,$2,$3,1800000,60000)`,
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

	// The runs/duration/tokens summary stays mono.
	const summary = await findByTestId('task-run-summary');
	expect(summary.textContent).toContain('1 run');
	expect(summary.textContent).toContain('41s');
	expect(summary.textContent).toContain('1.9M tokens');
	expect(summary.className).toContain('font-mono');
});
