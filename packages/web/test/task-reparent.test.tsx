import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('sidebar shows the parent for a sub-task and links to it', async () => {
	let projectSlug = '';
	let childIdentifier = '';
	let parentIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Reparent Project' });
			projectSlug = project.slug;
			const parent = await seedTask(ws, project, {
				title: 'Parent Task',
				assignee_id: engineer.id,
			});
			parentIdentifier = parent.identifier;

			const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${parent.id}/sub-tasks`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: 'Child Task', assignee_id: engineer.id }),
			});
			childIdentifier = (await res.json()).data.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: childIdentifier.toLowerCase() },
	});

	const link = await findByTestId('task-parent-link');
	expect(link.textContent).toContain(parentIdentifier);
	expect(link.getAttribute('href')).toContain(parentIdentifier.toLowerCase());
});

test('sidebar shows None and hides the promote action for a top-level task', async () => {
	let projectSlug = '';
	let identifier = '';

	const { findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Top Level Project' });
			projectSlug = project.slug;
			const task = await seedTask(ws, project, {
				title: 'Standalone Task',
				assignee_id: engineer.id,
			});
			identifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: identifier.toLowerCase() },
	});

	await findByTestId('task-parent-none');
	await user.click(await findByTestId('task-parent-change'));

	await waitFor(() => {
		expect(document.body.querySelector('[data-testid="change-parent-save"]')).not.toBeNull();
	});
	expect(document.body.querySelector('[data-testid="change-parent-promote"]')).toBeNull();
	expect(queryByTestId('task-parent-link')).toBeNull();
});

test('moving a sub-task to top level clears the breadcrumb ancestor', async () => {
	let projectSlug = '';
	let childIdentifier = '';

	const { findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Promote Project' });
			projectSlug = project.slug;
			const parent = await seedTask(ws, project, {
				title: 'Former Parent',
				assignee_id: engineer.id,
			});
			const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${parent.id}/sub-tasks`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: 'Escaping Child', assignee_id: engineer.id }),
			});
			childIdentifier = (await res.json()).data.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: childIdentifier.toLowerCase() },
	});

	await findByTestId('task-breadcrumb-ancestor');
	await user.click(await findByTestId('task-parent-change'));

	const promote = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="change-parent-promote"]');
		if (!el) throw new Error('promote button not rendered');
		return el as HTMLElement;
	});
	await user.click(promote);

	// The single projects.tasks(slug) invalidation is a key prefix, so the
	// ancestors query refetches without any extra wiring.
	await waitFor(() => {
		expect(queryByTestId('task-breadcrumb-ancestor')).toBeNull();
	});
	await findByTestId('task-parent-none');
});

test('the parent picker excludes the task itself and its descendants', async () => {
	let projectSlug = '';
	let moverIdentifier = '';
	let childIdentifier = '';
	let eligibleIdentifier = '';

	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Picker Project' });
			projectSlug = project.slug;

			const mover = await seedTask(ws, project, { title: 'Mover', assignee_id: engineer.id });
			moverIdentifier = mover.identifier;
			const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${mover.id}/sub-tasks`, {
				method: 'POST',
				headers: ws.headers,
				body: JSON.stringify({ title: 'Mover Child', assignee_id: engineer.id }),
			});
			childIdentifier = (await res.json()).data.identifier;

			const eligible = await seedTask(ws, project, {
				title: 'Eligible Destination',
				assignee_id: engineer.id,
			});
			eligibleIdentifier = eligible.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: moverIdentifier.toLowerCase() },
	});

	await user.click(await findByTestId('task-parent-change'));
	const trigger = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="change-parent-select"]');
		if (!el) throw new Error('select not rendered');
		return el as HTMLElement;
	});
	await user.click(trigger);

	// Options carry a per-value testid, so each one can be asserted directly
	// rather than by scanning body text (the task list behind the dialog mentions
	// every identifier, and the dialog subtitle names the mover).
	const option = (identifier: string) =>
		document.body.querySelector(`[data-testid="change-parent-select-option-${identifier}"]`);

	await waitFor(() => {
		expect(option(eligibleIdentifier)).not.toBeNull();
	});
	expect(option(moverIdentifier)).toBeNull();
	expect(option(childIdentifier)).toBeNull();
});

test('a rejected move shows the server error and leaves the breadcrumb unchanged', async () => {
	let projectSlug = '';
	let moverIdentifier = '';
	let deepIdentifier = '';

	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase }) => {
			const ws = await seedWorkspace();
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Rejection Project' });
			projectSlug = project.slug;

			// A chain at the full nesting depth: the deepest task cannot take another
			// child, so selecting it as a parent must be rejected by the server.
			const subTask = async (parentId: string, title: string) => {
				const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${parentId}/sub-tasks`, {
					method: 'POST',
					headers: ws.headers,
					body: JSON.stringify({ title, assignee_id: engineer.id }),
				});
				return (await res.json()).data;
			};

			const root = await seedTask(ws, project, { title: 'Chain Root', assignee_id: engineer.id });
			const mid = await subTask(root.id, 'Chain Mid');
			const lower = await subTask(mid.id, 'Chain Lower');
			deepIdentifier = (await subTask(lower.id, 'Chain Deep')).identifier;

			const mover = await seedTask(ws, project, {
				title: 'Rejected Mover',
				assignee_id: engineer.id,
			});
			moverIdentifier = mover.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: moverIdentifier.toLowerCase() },
	});

	await user.click(await findByTestId('task-parent-change'));
	const trigger = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="change-parent-select"]');
		if (!el) throw new Error('select not rendered');
		return el as HTMLElement;
	});
	await user.click(trigger);

	const option = await waitFor(() => {
		const el = document.body.querySelector(
			`[data-testid="change-parent-select-option-${deepIdentifier}"]`,
		);
		if (!el) throw new Error('deep option not rendered');
		return el as HTMLElement;
	});
	await user.click(option);

	const save = document.body.querySelector('[data-testid="change-parent-save"]') as HTMLElement;
	await user.click(save);

	const error = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="change-parent-error"]');
		if (!el) throw new Error('error not rendered');
		return el as HTMLElement;
	});
	expect(error.textContent).toMatch(/3 levels deep/);

	// The field is response-driven, so a rejection must leave the task where it
	// was rather than showing an optimistic move that never happened.
	await findByTestId('task-parent-none');
});
