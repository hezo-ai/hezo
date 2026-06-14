import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('task sidebar shows the amount spent on the task', async () => {
	const seeded = { projectSlug: '', taskId: '' };

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Spend Project' });
			const task = await seedTask(ws, project, { title: 'Spend Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			const { apiBase } = getTestContext();
			// Record spend against this task; the task's cost_cents rolls it up.
			await apiBase(`/api/projects/${project.slug}/costs`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({
					member_id: ws.agents[0].id,
					amount_cents: 175,
					task_id: task.id,
					project_id: project.id,
					description: 'task spend',
				}),
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const spent = await findByTestId('task-spent');
	expect(spent.textContent).toContain('$1.75');
});
