import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
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

test('sub-task row shows the running dot when the child has an active run', async () => {
	let teamSlug = '';
	let parentIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Running Sub-Task Project' });
			teamSlug = project.slug;
			const parent = await seedTask(ws, project, {
				title: 'Parent Task',
				assignee_id: engineer.id,
			});
			parentIdentifier = parent.identifier;

			const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${parent.id}/sub-tasks`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: 'Running child', assignee_id: engineer.id }),
			});
			if (!res.ok) throw new Error(`sub-task create failed: ${res.status}`);
			const child = ((await res.json()) as { data: { id: string } }).data;

			// Put an in-flight run on the child so its row lights up.
			await getTestContext().db.query(
				`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
				 VALUES ($1, $2, $3, 'running')`,
				[ws.team.id, engineer.id, child.id],
			);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: teamSlug, taskId: parentIdentifier.toLowerCase() },
	});

	const list = await findByTestId('sub-tasks-list');
	await waitFor(() => {
		const item = list.querySelector('[data-testid="sub-task-item"]');
		expect(item).not.toBeNull();
		expect(item?.querySelector('[data-testid="task-running-dot"]')).not.toBeNull();
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

test('Add opens the tailored sub-task dialog; creating one (with assignee) navigates to it', async () => {
	let projectSlug = '';
	let parentIdentifier = '';

	const { findByRole, findByTestId, findByLabelText, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Sub-Task Dialog Project' });
			projectSlug = project.slug;
			const parent = await seedTask(ws, project, {
				title: 'Dialog Parent',
				assignee_id: engineer.id,
			});
			parentIdentifier = parent.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: parentIdentifier.toLowerCase() },
	});

	await findByTestId('sub-tasks-toggle');

	// "+ Add" opens the tailored create dialog — titled for the sub-task and
	// carrying the parent's identifier, rather than the old inline title input.
	await user.click(await findByTestId('sub-tasks-add'));
	expect(await findByText(`Create sub-task · ${parentIdentifier}`)).toBeTruthy();

	const titleInput = await findByLabelText('Title');
	await user.type(titleInput, 'Dialog Child');

	// Assignee is required now — collecting it is the fix for the title-only bug.
	// The dialog is in a Radix portal on document.body; pick the first real option.
	await waitFor(() => {
		const optionsText = Array.from(document.body.querySelectorAll('option')).map(
			(o) => o.textContent,
		);
		expect(optionsText).toContain('Select assignee');
	});
	const assigneeSel = Array.from(document.body.querySelectorAll('select')).find((s) =>
		Array.from(s.options).some((o) => o.text === 'Select assignee'),
	) as HTMLSelectElement;
	await waitFor(() => {
		expect(Array.from(assigneeSel.options).some((o) => o.value !== '')).toBe(true);
	});
	const firstAgent = Array.from(assigneeSel.options).find((o) => o.value !== '');
	if (!firstAgent) throw new Error('expected an assignable agent option');
	await user.selectOptions(assigneeSel, firstAgent.value);

	await user.click(await findByRole('button', { name: 'Create' }));

	// The server accepts it (assignee present) and we land on the new sub-task.
	expect(await findByRole('heading', { name: 'Dialog Child' })).toBeTruthy();
});
