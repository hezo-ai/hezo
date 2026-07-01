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

test('filter selections persist for the same project across navigation away and back', async () => {
	let projectSlug = '';

	const { findByText, findByTestId, findByRole, queryByText, queryByTestId, router, user } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Persist Project' });
				const agentId = ws.agents[0].id;
				await seedTask(ws, project, { title: 'Backlog Task', assignee_id: agentId });
				const done = await seedTask(ws, project, { title: 'Done Task', assignee_id: agentId });
				await patchStatus(ws, done.id, 'done');
				projectSlug = project.slug;
			},
		});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	// Default view shows open work plus done tasks (done in its own bottom section).
	await findByText('Backlog Task', undefined, { timeout: 10_000 });
	await findByText('Done Task');

	// Set a non-default filter set: status → Done only, plus a sort change.
	const toggle = await findByTestId('task-filter-toggle');
	await user.click(toggle);
	await findByTestId('task-filter-panel');

	const statusBtn = await findByTestId('task-filter-status');
	await user.click(statusBtn);
	const clear = await findByRole('button', { name: 'Clear selection' });
	await user.click(clear);
	const doneOption = await findByRole('button', { name: 'Done' });
	await user.click(doneOption);
	await user.click(statusBtn);

	const sortField = (await findByTestId('task-filter-sort-field')) as HTMLSelectElement;
	await user.selectOptions(sortField, 'created_at');

	// Filter applied: the done task surfaces, the backlog task drops out.
	await waitFor(
		() => {
			expect(queryByText('Done Task')).not.toBeNull();
			expect(queryByText('Backlog Task')).toBeNull();
		},
		{ timeout: 10_000 },
	);

	// Navigate away (TaskList unmounts) ...
	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: projectSlug },
	});
	await waitFor(() => expect(queryByTestId('task-filter-bar')).toBeNull());

	// ... and back. The filter bar should restore the last-set selections without
	// any re-interaction: the done task is still the one shown.
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await waitFor(
		() => {
			expect(queryByText('Done Task')).not.toBeNull();
			expect(queryByText('Backlog Task')).toBeNull();
		},
		{ timeout: 10_000 },
	);

	// The persisted sort selection is reflected in the (collapsed → reopened) panel.
	await user.click(await findByTestId('task-filter-toggle'));
	const restoredSort = (await findByTestId('task-filter-sort-field')) as HTMLSelectElement;
	expect(restoredSort.value).toBe('created_at');
});

test('one project does not inherit another project filters', async () => {
	let projectA = '';
	let projectB = '';

	const { findByText, findByTestId, findByRole, queryByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const wsA = await seedWorkspace();
			const pA = await seedProject(wsA, { name: 'Project Alpha' });
			const doneA = await seedTask(wsA, pA, { title: 'Alpha Done', assignee_id: wsA.agents[0].id });
			await seedTask(wsA, pA, { title: 'Alpha Backlog', assignee_id: wsA.agents[0].id });
			await patchStatus(wsA, doneA.id, 'done');
			projectA = pA.slug;

			const wsB = await seedWorkspace();
			const pB = await seedProject(wsB, { name: 'Project Beta' });
			await seedTask(wsB, pB, { title: 'Beta Backlog', assignee_id: wsB.agents[0].id });
			projectB = pB.slug;
		},
	});

	// Project A: narrow the status filter to Done.
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectA },
	});
	await findByText('Alpha Backlog', undefined, { timeout: 10_000 });

	await user.click(await findByTestId('task-filter-toggle'));
	await findByTestId('task-filter-panel');
	const statusBtn = await findByTestId('task-filter-status');
	await user.click(statusBtn);
	await user.click(await findByRole('button', { name: 'Clear selection' }));
	await user.click(await findByRole('button', { name: 'Done' }));
	await user.click(statusBtn);

	await waitFor(
		() => {
			expect(queryByText('Alpha Done')).not.toBeNull();
			expect(queryByText('Alpha Backlog')).toBeNull();
		},
		{ timeout: 10_000 },
	);

	// Switch to project B (same route, different param — no remount). B has no
	// stored filters, so it must fall back to its own defaults and show its open
	// task — not inherit Alpha's Done-only filter.
	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectB },
	});

	await findByText('Beta Backlog', undefined, { timeout: 10_000 });

	// The collapsed summary reflects the default selection, not Alpha's.
	const summary = await findByTestId('task-filter-toggle');
	await waitFor(() => expect(summary.textContent).toContain('Open & done'));
	expect(summary.textContent).not.toContain('Status: Done');
});
