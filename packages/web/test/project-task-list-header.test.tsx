import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

// Component tier (happy-dom). ProjectTaskListHeader renders the onboarding phase
// banner when the project has an OPEN `team-coherence-review` task (the CEO is
// still onboarding the team). The progress-bar branch is intentionally disabled
// in the source (SHOW_TASK_PROGRESS_BAR=false) and already covered by
// task-progress-summary.test.tsx; this file covers the phase-banner path, which
// those tests don't reach.
//
// The banner is pure content driven by the real /tasks/progress-summary route —
// no real layout / WebSocket / viewport behaviour — so it stays component-tier.

/** Label a seeded task as an OPEN team-coherence-review so phase_banner fires. */
async function makeCoherenceReviewTask(taskId: string, status = 'in_progress'): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`UPDATE tasks
		   SET labels = '["team-coherence-review"]'::jsonb,
		       status = $2::task_status
		 WHERE id = $1`,
		[taskId, status],
	);
}

async function renderTasksPage(
	build: (ws: SeededWorkspace, project: SeededProject) => Promise<void>,
) {
	const ref = { projectSlug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Header Project' });
			ref.projectSlug = project.slug;
			await build(ws, project);
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: ref.projectSlug },
	});
	return { ...helpers, ref };
}

test('renders the onboarding phase banner while a coherence-review task is open', async () => {
	const { findByTestId } = await renderTasksPage(async (ws, project) => {
		const task = await seedTask(ws, project, { title: 'Coherence review' });
		await makeCoherenceReviewTask(task.id);
	});

	const banner = await findByTestId('project-task-list-phase-banner-onboarding', undefined, {
		timeout: 15_000,
	});
	expect(banner.textContent).toContain('Please wait whilst the CEO onboards your new team members');
	// It's announced as a status region for assistive tech.
	expect(banner.getAttribute('role')).toBe('status');
});

test('does NOT render the banner once the coherence-review task is closed', async () => {
	const { findByTestId, queryByTestId } = await renderTasksPage(async (ws, project) => {
		const task = await seedTask(ws, project, { title: 'Coherence review' });
		// Closed → excluded from the coherence query → phase_banner is null.
		await makeCoherenceReviewTask(task.id, 'closed');
	});

	// The task list mounts, but no onboarding banner is shown.
	await findByTestId('task-list-main', undefined, { timeout: 15_000 });
	await waitFor(() => {
		expect(queryByTestId('project-task-list-phase-banner-onboarding')).toBeNull();
	});
	// And the (disabled) progress bar stays hidden too.
	expect(queryByTestId('task-progress-bar')).toBeNull();
});

test('does NOT render the banner for a plain project with no coherence-review task', async () => {
	const { findByTestId, queryByTestId } = await renderTasksPage(async (ws, project) => {
		await seedTask(ws, project, { title: 'Ordinary task' });
	});

	await findByTestId('task-list-main', undefined, { timeout: 15_000 });
	await waitFor(() => {
		expect(queryByTestId('project-task-list-phase-banner-onboarding')).toBeNull();
	});
});
