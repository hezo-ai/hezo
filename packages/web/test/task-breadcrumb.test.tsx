import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('sub-task header shows a breadcrumb link to its parent and navigates there', async () => {
	const seeded = {
		projectSlug: '',
		childPath: '',
		childIdentifier: '',
		parentIdentifier: '',
	};
	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Breadcrumb Project' });
			const parent = await seedTask(ws, project, { title: 'Parent Task' });
			// Sub-tasks aren't expressible through seedTask, so create one through the
			// real /sub-tasks endpoint — it inherits the parent's project.
			const subRes = await ctx.apiBase(
				`/api/projects/${project.slug}/tasks/${parent.id}/sub-tasks`,
				{
					method: 'POST',
					headers: ws.headers,
					body: JSON.stringify({ title: 'Child Task', assignee_id: ws.agents[0].id }),
				},
			);
			const child = ((await subRes.json()) as { data: { identifier: string } }).data;
			seeded.projectSlug = project.slug;
			seeded.parentIdentifier = parent.identifier;
			seeded.childIdentifier = child.identifier;
			seeded.childPath = child.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.childPath },
	});

	// The breadcrumb ends in the current task's identifier...
	const breadcrumb = await findByTestId('task-breadcrumb');
	expect(breadcrumb.textContent).toContain(seeded.childIdentifier);

	// ...and is preceded by a link to the parent.
	const parentLink = await findByTestId('task-breadcrumb-ancestor');
	expect(parentLink.textContent).toBe(seeded.parentIdentifier);
	expect(parentLink.getAttribute('href')).toContain(seeded.parentIdentifier.toLowerCase());

	// Clicking it navigates to the parent task.
	await user.click(parentLink);
	await waitFor(() =>
		expect(router.state.location.pathname).toContain(seeded.parentIdentifier.toLowerCase()),
	);
});

test('top-level task header shows only its identifier with no ancestor links', async () => {
	const seeded = { projectSlug: '', taskPath: '', identifier: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Solo Project' });
			const task = await seedTask(ws, project, { title: 'Solo Task' });
			seeded.projectSlug = project.slug;
			seeded.taskPath = task.identifier.toLowerCase();
			seeded.identifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskPath },
	});

	const breadcrumb = await findByTestId('task-breadcrumb');
	expect(breadcrumb.textContent).toContain(seeded.identifier);
	// No parent → the breadcrumb is just the current identifier, no ancestor crumb.
	expect(queryByTestId('task-breadcrumb-ancestor')).toBeNull();
});
