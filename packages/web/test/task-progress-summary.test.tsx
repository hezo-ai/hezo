import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function patchStatus(ws: SeededWorkspace, taskId: string, status: string) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${taskId}`, {
		method: 'PATCH',
		headers: ws.headers,
		body: JSON.stringify({ status }),
	});
	if (!res.ok) throw new Error(`patchStatus failed: ${res.status} ${await res.text()}`);
}

async function planningTaskId(ws: SeededWorkspace, projectId: string): Promise<string> {
	const { db } = getTestContext();
	const row = await db.query<{ id: string }>(
		`SELECT id FROM tasks WHERE project_id = $1 AND labels @> '["planning"]'::jsonb LIMIT 1`,
		[projectId],
	);
	const id = row.rows[0]?.id;
	if (!id) throw new Error('planningTaskId: no planning epic');
	return id;
}

test('tasks page hides progress area while the planning ticket is open', async () => {
	let projectSlug = '';

	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Gate Project' });
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByTestId('task-list-main', undefined, { timeout: 10_000 });
	expect(queryByTestId('task-progress-bar')).toBeNull();
	expect(queryByTestId('project-task-list-phase-banner-planning')).toBeNull();
});

test('tasks page shows segmented progress bar after the planning ticket is closed', async () => {
	let projectSlug = '';
	let ws!: SeededWorkspace;

	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Progress Project' });
			projectSlug = project.slug;

			const planningId = await planningTaskId(ws, project.id);
			const engineer = ws.agents.find((a) => a.slug === 'engineer');
			if (!engineer) throw new Error('missing agents');

			await patchStatus(ws, planningId, 'closed');

			const exec = await seedTask(ws, project, {
				title: 'Build API',
				assignee_id: engineer.id,
			});
			await patchStatus(ws, exec.id, 'done');
			await seedTask(ws, project, {
				title: 'Build UI',
				assignee_id: engineer.id,
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByTestId('task-progress-bar', undefined, { timeout: 10_000 });
	await findByTestId('project-status-idle');
	await findByText('50% complete');
	await waitFor(() => {
		expect(document.querySelector('[data-testid="task-progress-segment-complete"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="task-progress-segment-not-done"]')).not.toBeNull();
	});
});
