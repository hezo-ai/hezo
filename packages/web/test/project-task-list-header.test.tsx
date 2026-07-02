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
// still onboarding the team). It is the header's only responsibility.
//
// The banner is pure content driven by the real /tasks/phase-banner route —
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

test('does NOT render the banner once the coherence-review task is done', async () => {
	const { findByTestId, queryByTestId } = await renderTasksPage(async (ws, project) => {
		const task = await seedTask(ws, project, { title: 'Coherence review' });
		// Done (terminal) → excluded from the coherence query → phase_banner is null.
		await makeCoherenceReviewTask(task.id, 'done');
	});

	// The task list mounts, but no onboarding banner is shown.
	await findByTestId('task-list-main', undefined, { timeout: 15_000 });
	await waitFor(() => {
		expect(queryByTestId('project-task-list-phase-banner-onboarding')).toBeNull();
	});
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
