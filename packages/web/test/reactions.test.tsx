import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('add and remove a reaction toggles the chip', async () => {
	let ids: { teamSlug: string; projectSlug: string; taskIdentifier: string };
	const { findByTestId, queryAllByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Reactions Project' });
			const task = await seedTask(ws, project, { title: 'Reactions Task' });
			await seedComment(ws, task, 'A comment to react to.');
			ids = {
				teamSlug: ws.team.slug,
				projectSlug: project.slug,
				taskIdentifier: task.identifier.toLowerCase(),
			};
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: ids!.teamSlug,
			projectId: ids!.projectSlug,
			taskId: ids!.taskIdentifier,
		},
	});

	const addButton = await findByTestId('add-reaction-button', undefined, { timeout: 10_000 });
	await user.click(addButton);

	const picker = await findByTestId('reaction-picker', undefined, { timeout: 5_000 });
	const ackBtn = picker.querySelector('[data-reaction-kind="ack"]') as HTMLButtonElement;
	expect(ackBtn).not.toBeNull();
	await user.click(ackBtn);

	await waitFor(
		async () => {
			const reactions = await findByTestId('comment-reactions');
			const chip = reactions.querySelector('[data-reaction-kind="ack"]');
			expect(chip).not.toBeNull();
			expect(chip?.getAttribute('data-you-reacted')).toBe('true');
			expect(chip?.textContent).toContain('1');
		},
		{ timeout: 10_000 },
	);

	const reactionsRegion = await findByTestId('comment-reactions');
	const chip = reactionsRegion.querySelector('[data-reaction-kind="ack"]') as HTMLButtonElement;
	await user.click(chip);

	await waitFor(
		() => {
			const stillThere = queryAllByTestId('comment-reactions').flatMap((r) =>
				Array.from(r.querySelectorAll('[data-reaction-kind="ack"][data-you-reacted="true"]')),
			);
			expect(stillThere).toHaveLength(0);
		},
		{ timeout: 10_000 },
	);
});

test('reactions seeded via API render on page load', async () => {
	let ids: { teamSlug: string; projectSlug: string; taskIdentifier: string };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Reactions Project' });
			const task = await seedTask(ws, project, { title: 'Reactions Task' });
			const comment = await seedComment(ws, task, 'Pre-seeded reaction comment.');
			const { apiBase } = getTestContext();
			await apiBase(
				`/api/teams/${ws.team.id}/tasks/${task.id}/comments/${comment.id}/reactions/ack`,
				{ method: 'PUT', headers: ws.headers },
			);
			ids = {
				teamSlug: ws.team.slug,
				projectSlug: project.slug,
				taskIdentifier: task.identifier.toLowerCase(),
			};
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: ids!.teamSlug,
			projectId: ids!.projectSlug,
			taskId: ids!.taskIdentifier,
		},
	});

	await waitFor(
		async () => {
			const reactions = await findByTestId('comment-reactions');
			const chip = reactions.querySelector('[data-reaction-kind="ack"]');
			expect(chip).not.toBeNull();
			expect(chip?.getAttribute('data-you-reacted')).toBe('true');
			expect(chip?.textContent).toContain('1');
		},
		{ timeout: 10_000 },
	);
});

test('reacting does not create any new comments', async () => {
	let ids: {
		teamSlug: string;
		projectSlug: string;
		taskIdentifier: string;
		taskId: string;
		teamId: string;
		commentId: string;
	};
	let beforeRows: Array<{ id: string }>;
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Reactions Project' });
			const task = await seedTask(ws, project, { title: 'Reactions Task' });
			const comment = await seedComment(ws, task, 'A comment to react to.');
			const { apiBase } = getTestContext();
			const before = await apiBase(`/api/teams/${ws.team.id}/tasks/${task.id}/comments`, {
				headers: ws.headers,
			});
			beforeRows = ((await before.json()) as { data: Array<{ id: string }> }).data;
			ids = {
				teamSlug: ws.team.slug,
				projectSlug: project.slug,
				taskIdentifier: task.identifier.toLowerCase(),
				taskId: task.id,
				teamId: ws.team.id,
				commentId: comment.id,
			};
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: ids!.teamSlug,
			projectId: ids!.projectSlug,
			taskId: ids!.taskIdentifier,
		},
	});

	const addButton = await findByTestId('add-reaction-button', undefined, { timeout: 10_000 });
	await user.click(addButton);
	const picker = await findByTestId('reaction-picker');
	const ackBtn = picker.querySelector('[data-reaction-kind="ack"]') as HTMLButtonElement;
	await user.click(ackBtn);

	// Wait until the chip is rendered, indicating the PUT mutation + refetch landed.
	await waitFor(
		async () => {
			const reactions = await findByTestId('comment-reactions');
			expect(reactions.querySelector('[data-reaction-kind="ack"]')).not.toBeNull();
		},
		{ timeout: 10_000 },
	);

	const { apiBase } = getTestContext();
	const after = await apiBase(`/api/teams/${ids!.teamId}/tasks/${ids!.taskId}/comments`, {
		headers: { Authorization: `Bearer ${getTestContext().token}` },
	});
	const afterRows = (
		(await after.json()) as {
			data: Array<{ id: string; reactions?: Array<{ kind: string; members: unknown[] }> }>;
		}
	).data;
	expect(afterRows.length).toBe(beforeRows!.length);
	const c = afterRows.find((r) => r.id === ids!.commentId);
	expect(c?.reactions?.find((r) => r.kind === 'ack')?.members).toHaveLength(1);
});
