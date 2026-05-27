import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededWorkspace,
	seedComment,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

async function patchTask(ws: SeededWorkspace, taskId: string, patch: Record<string, unknown>) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/teams/${ws.team.id}/tasks/${taskId}`, {
		method: 'PATCH',
		headers: ws.headers,
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`patchTask failed: ${res.status} ${await res.text()}`);
	return res;
}

async function createTaskWithBlockers(
	ws: SeededWorkspace,
	projectId: string,
	input: { title: string; assignee_id: string; blocked_by_task_ids: string[] },
) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/teams/${ws.team.id}/tasks`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ project_id: projectId, ...input }),
	});
	if (!res.ok) throw new Error(`createTaskWithBlockers failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { data: { id: string; identifier: string } }).data;
}

test('status changes and cross-task mentions appear as system entries on the timeline', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let targetIdentifier = '';
	let sourceIdentifier = '';
	let targetTaskId = '';
	let sourceTaskId = '';
	let workspace: SeededWorkspace;

	const { findByText, findAllByTestId, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			workspace = await seedWorkspace();
			const project = await seedProject(workspace, { name: 'History Project' });
			const target = await seedTask(workspace, project, {
				title: 'Target ticket',
				assignee_id: workspace.agents[0].id,
			});
			const source = await seedTask(workspace, project, {
				title: 'Source ticket',
				assignee_id: workspace.agents[0].id,
			});
			// Close target by patching status.
			await patchTask(workspace, target.id, { status: 'closed' });
			// Post a comment on source that mentions target — should fan out a
			// "Linked from" system entry on target.
			await seedComment(workspace, source, `context: ${target.identifier}`);
			teamSlug = workspace.team.slug;
			projectSlug = project.slug;
			targetIdentifier = target.identifier;
			sourceIdentifier = source.identifier;
			targetTaskId = target.id;
			sourceTaskId = source.id;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: teamSlug,
			projectId: projectSlug,
			taskId: targetIdentifier.toLowerCase(),
		},
	});

	await findByText('Target ticket', undefined, { timeout: 10_000 });

	// The status-change system comment should be present.
	await waitFor(
		async () => {
			const items = await findAllByTestId('comment-item');
			const statusChange = items.find((el) => /changed status/i.test(el.textContent ?? ''));
			expect(statusChange).toBeDefined();
		},
		{ timeout: 10_000 },
	);

	// Verify "Linked from <source>" landed on target.
	await waitFor(
		async () => {
			const items = await findAllByTestId('comment-item');
			const linked = items.filter((el) =>
				new RegExp(`Linked from ${sourceIdentifier}`).test(el.textContent ?? ''),
			);
			expect(linked.length).toBe(1);
		},
		{ timeout: 10_000 },
	);

	// Post a second mention from the same source — should NOT add a duplicate
	// "Linked from" entry.
	const { apiBase } = getTestContext();
	await apiBase(`/api/teams/${workspace!.team.id}/tasks/${sourceTaskId}/comments`, {
		method: 'POST',
		headers: workspace!.headers,
		body: JSON.stringify({
			content_type: 'text',
			content: { text: `still on ${targetIdentifier}` },
		}),
	});

	// Trigger a refetch by navigating away and back.
	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: teamSlug, projectId: projectSlug },
	});
	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: teamSlug,
			projectId: projectSlug,
			taskId: targetIdentifier.toLowerCase(),
		},
	});

	await findByText('Target ticket', undefined, { timeout: 10_000 });
	await waitFor(
		async () => {
			const items = await findAllByTestId('comment-item');
			const linked = items.filter((el) =>
				new RegExp(`Linked from ${sourceIdentifier}`).test(el.textContent ?? ''),
			);
			expect(linked.length).toBe(1);
		},
		{ timeout: 10_000 },
	);
});

test('title renames appear as system entries on the timeline', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByText, findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Rename Project' });
			const task = await seedTask(ws, project, {
				title: 'Original ticket',
				assignee_id: ws.agents[0].id,
			});
			await patchTask(ws, task.id, { title: 'Renamed ticket' });
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
			taskIdentifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: teamSlug,
			projectId: projectSlug,
			taskId: taskIdentifier.toLowerCase(),
		},
	});

	await findByText('Renamed ticket', undefined, { timeout: 10_000 });

	await waitFor(
		async () => {
			const items = await findAllByTestId('comment-item');
			const match = items.find((el) => /renamed from/i.test(el.textContent ?? ''));
			expect(match).toBeDefined();
		},
		{ timeout: 10_000 },
	);
});

test('auto-unblock cascade renders as system attribution, not the patcher', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let downstreamIdentifier = '';
	let blockerIdentifier = '';
	let closerTitle = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			expect(ws.agents.length).toBeGreaterThanOrEqual(2);
			const [closer, owner] = ws.agents;
			closerTitle = closer.title;
			const project = await seedProject(ws, { name: 'Cascade Project' });
			const blocker = await seedTask(ws, project, {
				title: 'Blocker ticket',
				assignee_id: closer.id,
			});
			const downstream = await createTaskWithBlockers(ws, project.id, {
				title: 'Downstream ticket',
				assignee_id: owner.id,
				blocked_by_task_ids: [blocker.identifier],
			});
			// Close the blocker — should auto-unblock the downstream task.
			await patchTask(ws, blocker.id, { status: 'done' });
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
			downstreamIdentifier = downstream.identifier;
			blockerIdentifier = blocker.identifier;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: teamSlug,
			projectId: projectSlug,
			taskId: downstreamIdentifier.toLowerCase(),
		},
	});

	const cascadeEntry = await findByTestId('status-change-cascade', undefined, {
		timeout: 10_000,
	});
	expect(cascadeEntry.textContent).toContain('Auto-unblocked');
	expect(cascadeEntry.textContent).toContain(blockerIdentifier);
	expect(cascadeEntry.textContent).not.toContain(closerTitle);
	expect(cascadeEntry.textContent ?? '').not.toMatch(/changed status/i);
});

test('reassignments appear as system entries on the timeline', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			expect(ws.agents.length).toBeGreaterThanOrEqual(2);
			const [first, second] = ws.agents;
			const project = await seedProject(ws, { name: 'Reassign Project' });
			const task = await seedTask(ws, project, {
				title: 'Reassign me',
				assignee_id: first.id,
			});
			await patchTask(ws, task.id, { assignee_id: second.id });
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
			taskIdentifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: teamSlug,
			projectId: projectSlug,
			taskId: taskIdentifier.toLowerCase(),
		},
	});

	await waitFor(
		async () => {
			const items = await findAllByTestId('comment-item');
			const match = items.find((el) => /reassigned from/i.test(el.textContent ?? ''));
			expect(match).toBeDefined();
		},
		{ timeout: 15_000 },
	);
});
