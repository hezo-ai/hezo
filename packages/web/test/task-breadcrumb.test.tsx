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

	// ...starts with a "Tasks" link back to the project's task list...
	const tasksLink = await findByTestId('task-breadcrumb-tasks');
	expect(tasksLink.textContent).toBe('Tasks');
	expect(tasksLink.getAttribute('href')).toContain(`/projects/${seeded.projectSlug}/tasks`);

	// ...and is preceded by a link to the parent.
	const parentLink = await findByTestId('task-breadcrumb-ancestor');
	expect(parentLink.textContent).toBe(seeded.parentIdentifier);
	expect(parentLink.getAttribute('href')).toContain(seeded.parentIdentifier.toLowerCase());

	// The task's own name rides in the crumb beside its identifier, and carries
	// the untruncated text in `title` for the widths where it is cut short.
	const crumbTitle = await findByTestId('task-breadcrumb-title');
	expect(crumbTitle.textContent).toBe('Child Task');
	expect(crumbTitle.getAttribute('title')).toBe('Child Task');

	// A sub-task also renders the below-`sm` stand-in for the ancestor chain. The
	// links themselves stay in the tree at every width (sr-only, never `hidden`),
	// which is why both are present here - happy-dom runs no media queries.
	expect(await findByTestId('task-breadcrumb-ancestors-collapsed')).toBeTruthy();

	// Clicking it navigates to the parent task.
	await user.click(parentLink);
	await waitFor(() =>
		expect(router.state.location.pathname).toContain(seeded.parentIdentifier.toLowerCase()),
	);
});

test('top-level task header shows a Tasks crumb and its identifier with no ancestor links', async () => {
	const seeded = { projectSlug: '', taskPath: '', identifier: '' };
	const { findByTestId, queryByTestId, router, user } = await renderApp({
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
	// No parent → neither an ancestor crumb nor the ellipsis standing in for one,
	// but the Tasks list crumb is always there.
	expect(queryByTestId('task-breadcrumb-ancestor')).toBeNull();
	expect(queryByTestId('task-breadcrumb-ancestors-collapsed')).toBeNull();

	// The name is carried at rest too, not only once the crumb pins.
	const crumbTitle = await findByTestId('task-breadcrumb-title');
	expect(crumbTitle.textContent).toBe('Solo Task');
	const tasksLink = await findByTestId('task-breadcrumb-tasks');
	expect(tasksLink.getAttribute('href')).toContain(`/projects/${seeded.projectSlug}/tasks`);

	// Clicking it navigates back to the task list.
	await user.click(tasksLink);
	await waitFor(() =>
		expect(router.state.location.pathname).toBe(`/projects/${seeded.projectSlug}/tasks`),
	);
});
