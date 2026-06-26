import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

async function renderOnProjectTasks() {
	let projectSlug = '';
	const app = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Float Project' });
			projectSlug = project.slug;
		},
	});
	await app.router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});
	return app;
}

test('the floating new-task button opens the create-task dialog on a project route', async () => {
	const { findByTestId, user } = await renderOnProjectTasks();

	const floating = await findByTestId('floating-new-task');
	await user.click(floating);

	// The dialog renders into a Radix portal on document.body.
	await waitFor(() =>
		expect(
			Array.from(document.body.querySelectorAll('h2,[role="dialog"] *')).some(
				(el) => el.textContent === 'Create Task',
			),
		).toBe(true),
	);
});

test('the floating new-task button is hidden while the CEO chat is open', async () => {
	const { findByTestId, queryByTestId, user } = await renderOnProjectTasks();

	// Present on a project route to start with.
	await findByTestId('floating-new-task');

	// Opening the chat takes over the corner — the floating button hides.
	await user.click(await findByTestId('ceo-chat-launcher'));
	await findByTestId('ceo-chat-panel');
	await waitFor(() => expect(queryByTestId('floating-new-task')).toBeNull());

	// Closing the chat brings it back.
	await user.click(await findByTestId('ceo-chat-close'));
	await findByTestId('floating-new-task');
});

test('the sidebar "+" next to Tasks opens the create-task dialog', async () => {
	const { findByTestId, user } = await renderOnProjectTasks();

	const plus = await findByTestId('project-sidebar-new-task');
	await user.click(plus);

	await waitFor(() =>
		expect(
			Array.from(document.body.querySelectorAll('h2,[role="dialog"] *')).some(
				(el) => el.textContent === 'Create Task',
			),
		).toBe(true),
	);
});

test('no floating new-task button off a project route', async () => {
	const { queryByTestId } = await renderApp({ initialPath: '/home' });
	await waitFor(() => expect(queryByTestId('ceo-chat-launcher')).not.toBeNull());
	expect(queryByTestId('floating-new-task')).toBeNull();
});
