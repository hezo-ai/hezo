import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('sub-tasks panel is expanded by default and collapses on click', async () => {
	let teamSlug = '';
	let parentIdentifier = '';

	const { findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Sub-Tasks Project' });
			teamSlug = project.slug;
			const parent = await seedTask(ws, project, {
				title: 'Parent Task',
				assignee_id: engineer.id,
			});
			parentIdentifier = parent.identifier;

			for (const title of ['Child Task Alpha', 'Child Task Beta']) {
				const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${parent.id}/sub-tasks`, {
					method: 'POST',
					headers: ws.headers,
					body: JSON.stringify({ title, assignee_id: engineer.id }),
				});
				if (!res.ok) throw new Error(`sub-task create failed: ${res.status}`);
			}
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: teamSlug, taskId: parentIdentifier.toLowerCase() },
	});

	const toggle = await findByTestId('sub-tasks-toggle');
	expect(toggle.textContent).toContain('Sub-tasks');
	expect(toggle.getAttribute('aria-expanded')).toBe('true');
	await waitFor(() => {
		expect(toggle.textContent).toContain('2');
	});

	const list = await findByTestId('sub-tasks-list');
	await waitFor(() => {
		expect(list.textContent).toContain('Child Task Alpha');
		expect(list.textContent).toContain('Child Task Beta');
	});
	expect(queryByTestId('sub-tasks-show-more')).toBeNull();

	await user.click(toggle);
	await waitFor(() => {
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(queryByTestId('sub-tasks-list')).toBeNull();
	});
});

test('sub-tasks paginate to team page size with a Show more link', async () => {
	let teamSlug = '';
	let parentIdentifier = '';

	const { findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];

			const patchRes = await apiBase(`/api/projects/${ws.internalSlug}/team`, {
				method: 'PATCH',
				headers: ws.headers,
				body: JSON.stringify({ settings: { subtask_page_size: 3 } }),
			});
			if (!patchRes.ok) throw new Error('failed to patch team settings');
			const verify = await apiBase(`/api/projects/${ws.internalSlug}/team`, {
				headers: ws.headers,
			});
			const teamRow = (await verify.json()) as {
				data: { settings: { subtask_page_size?: number } };
			};
			if (teamRow.data.settings?.subtask_page_size !== 3) {
				throw new Error(
					`subtask_page_size not persisted: ${JSON.stringify(teamRow.data.settings)}`,
				);
			}

			const project = await seedProject(ws, { name: 'Pagination Project' });
			teamSlug = project.slug;
			const parent = await seedTask(ws, project, {
				title: 'Pagination Parent',
				assignee_id: engineer.id,
			});
			parentIdentifier = parent.identifier;

			const titles = ['Sub A', 'Sub B', 'Sub C', 'Sub D', 'Sub E', 'Sub F', 'Sub G'];
			for (const title of titles) {
				const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${parent.id}/sub-tasks`, {
					method: 'POST',
					headers: ws.headers,
					body: JSON.stringify({ title, assignee_id: engineer.id }),
				});
				if (!res.ok) throw new Error(`sub-task create failed: ${res.status}`);
			}
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: teamSlug, taskId: parentIdentifier.toLowerCase() },
	});

	const list = await findByTestId('sub-tasks-list');
	const countItems = () => list.querySelectorAll('[data-testid="sub-task-item"]').length;

	// Wait for team settings to load (page size collapses from 10 → 3).
	await waitFor(
		() => {
			expect(countItems()).toBe(3);
		},
		{ timeout: 10_000 },
	);

	let showMore = await findByTestId('sub-tasks-show-more');
	expect(showMore.textContent).toContain('4 hidden');

	await user.click(showMore);
	await waitFor(() => {
		expect(countItems()).toBe(6);
	});
	showMore = await findByTestId('sub-tasks-show-more');
	expect(showMore.textContent).toContain('1 hidden');

	await user.click(showMore);
	await waitFor(() => {
		expect(countItems()).toBe(7);
		expect(queryByTestId('sub-tasks-show-more')).toBeNull();
	});
});

test('sub-tasks card sits between the description card and the comments heading', async () => {
	let teamSlug = '';
	let taskIdentifier = '';

	const { findByTestId, findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Layout Project' });
			teamSlug = project.slug;
			const task = await seedTask(ws, project, {
				title: 'Layout Parent',
				description: 'Some description body.',
				assignee_id: engineer.id,
			});
			taskIdentifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: teamSlug, taskId: taskIdentifier.toLowerCase() },
	});

	const descriptionCard = await findByTestId('task-description-card');
	expect(descriptionCard.textContent).toContain('Description');
	expect(descriptionCard.querySelector('[data-testid="task-description"]')).toBeTruthy();

	const subTasksCard = await findByTestId('sub-tasks-card');
	const commentsHeading = await findByRole('heading', { name: 'Comments' });

	// DOM-order check stands in for the e2e bounding-box assertion.
	expect(
		descriptionCard.compareDocumentPosition(subTasksCard) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		subTasksCard.compareDocumentPosition(commentsHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});
