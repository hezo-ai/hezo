import { screen, waitFor } from '@testing-library/react';
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

test('the floating new-task button is available off a project route and offers a project picker', async () => {
	const { findByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Off-route Project' });
		},
	});

	// Global now: the button shows even with no project in the route.
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
	// …and the form leads with a project selector (the fixed-project call sites don't).
	await screen.findByTestId('create-task-project');
});

test('the floating dialog scopes the assignee list to the chosen project', async () => {
	let alpha = { slug: '', captain: '' };
	let beta = { slug: '', captain: '' };
	const { findByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const a = await seedWorkspace();
			const ap = await seedProject(a, { name: 'Alpha' });
			const b = await seedWorkspace();
			const bp = await seedProject(b, { name: 'Beta' });
			// Captain is team-local (a distinct row per team), so its id is the
			// cleanest fingerprint that the assignee list followed the project.
			alpha = { slug: ap.slug, captain: a.agents.find((x) => x.slug === 'captain')?.id ?? '' };
			beta = { slug: bp.slug, captain: b.agents.find((x) => x.slug === 'captain')?.id ?? '' };
		},
	});

	await user.click(await findByTestId('floating-new-task'));
	const projectSelect = (await screen.findByTestId('create-task-project')) as HTMLSelectElement;
	const assignee = (await screen.findByTestId('create-task-assignee')) as HTMLSelectElement;

	// Pick Alpha → its roster (incl. Alpha's Captain) fills the assignee select.
	await user.selectOptions(projectSelect, alpha.slug);
	await waitFor(() => {
		const values = Array.from(assignee.options).map((o) => o.value);
		expect(values).toContain(alpha.captain);
		expect(values).not.toContain(beta.captain);
	});

	// Switch to Beta → the assignee options swap and the prior choice is cleared.
	await user.selectOptions(projectSelect, beta.slug);
	await waitFor(() => {
		const values = Array.from(assignee.options).map((o) => o.value);
		expect(values).toContain(beta.captain);
		expect(values).not.toContain(alpha.captain);
	});
	expect(assignee.value).toBe('');
});
