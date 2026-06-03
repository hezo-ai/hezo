import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

interface SeededSubTask {
	id: string;
	identifier: string;
	title: string;
}

async function createSubTask(
	ws: SeededWorkspace,
	parentId: string,
	input: { title: string; assignee_id?: string },
): Promise<SeededSubTask> {
	const { apiBase } = getTestContext();
	const assigneeId = input.assignee_id ?? ws.agents[0].id;
	const res = await apiBase(`/api/teams/${ws.team.id}/tasks/${parentId}/sub-tasks`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ title: input.title, assignee_id: assigneeId }),
	});
	if (!res.ok) throw new Error(`createSubTask failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { data: SeededSubTask }).data;
}

test('breadcrumb walks the parent chain on a sub-sub-task', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let rootIdentifier = '';
	let subIdentifier = '';
	let subSubIdentifier = '';

	const { findByRole, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Breadcrumb Project' });
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const root = await seedTask(ws, project, {
				title: 'Root Task',
				assignee_id: engineer.id,
			});
			const sub = await createSubTask(ws, root.id, {
				title: 'Sub Task',
				assignee_id: engineer.id,
			});
			const subSub = await createSubTask(ws, sub.id, {
				title: 'Sub-Sub Task',
				assignee_id: engineer.id,
			});
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
			rootIdentifier = root.identifier;
			subIdentifier = sub.identifier;
			subSubIdentifier = subSub.identifier;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: teamSlug,
			projectId: projectSlug,
			taskId: subSubIdentifier.toLowerCase(),
		},
	});

	await findByRole('heading', { name: 'Sub-Sub Task' });

	const breadcrumb = await findByTestId('breadcrumb');
	await waitFor(() => {
		expect(breadcrumb.textContent).toContain(rootIdentifier);
		expect(breadcrumb.textContent).toContain(subIdentifier);
		expect(breadcrumb.textContent).toContain(subSubIdentifier);
	});

	const rootLink = Array.from(breadcrumb.querySelectorAll('a')).find(
		(a) => a.textContent === rootIdentifier,
	);
	expect(rootLink).toBeTruthy();
	await user.click(rootLink!);
	await findByRole('heading', { name: 'Root Task' });
});

test('breadcrumb on a top-level task shows no ancestors', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByRole, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Top Project' });
			const task = await seedTask(ws, project, {
				title: 'Top-Level Task',
			});
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

	await findByRole('heading', { name: 'Top-Level Task' });
	const breadcrumb = await findByTestId('breadcrumb');
	expect(breadcrumb.textContent).toContain('Tasks');
	expect(breadcrumb.textContent).toContain(taskIdentifier);
	// Team chip + Project + Tasks = 3 anchors before the final, non-linked identifier
	expect(breadcrumb.querySelectorAll('a').length).toBe(3);
});

test('UI surfaces the depth-cap error when creating a sub-task under a depth-2 ticket', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let subSubIdentifier = '';

	const { findByRole, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Depth Project' });
			const engineer = ws.agents.find((a) => a.slug === 'engineer') ?? ws.agents[0];
			const root = await seedTask(ws, project, {
				title: 'Depth Root',
				assignee_id: engineer.id,
			});
			const sub = await createSubTask(ws, root.id, {
				title: 'Depth Sub',
				assignee_id: engineer.id,
			});
			const subSub = await createSubTask(ws, sub.id, {
				title: 'Depth Sub-Sub',
				assignee_id: engineer.id,
			});
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
			subSubIdentifier = subSub.identifier;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: teamSlug,
			projectId: projectSlug,
			taskId: subSubIdentifier.toLowerCase(),
		},
	});

	await findByRole('heading', { name: 'Depth Sub-Sub' });

	const addButton = await findByTestId('sub-tasks-add');
	await user.click(addButton);

	const titleInput = await findByTestId('sub-task-title-input');
	await user.type(titleInput, 'Should be rejected');

	const createBtn = await findByRole('button', { name: 'Create' });
	await user.click(createBtn);

	const errorEl = await findByTestId('sub-task-error');
	expect(errorEl.textContent).toMatch(/2 levels deep/);
});

test('canonical task URL is project-scoped; short and UUID forms redirect', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';
	let taskId = '';
	const taskTitle = 'Friendly URL task';

	const { findByRole, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'URL Test Project' });
			const captain = ws.agents.find((a) => a.slug === 'captain')!;
			const task = await seedTask(ws, project, {
				title: taskTitle,
				assignee_id: captain.id,
			});
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
			taskIdentifier = task.identifier;
			taskId = task.id;
		},
	});

	const friendly = taskIdentifier.toLowerCase();
	const canonicalPath = `/teams/${teamSlug}/projects/${projectSlug}/tasks/${friendly}`;

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: { teamId: teamSlug, projectId: projectSlug, taskId: friendly },
	});
	await findByRole('heading', { name: taskTitle });
	expect(router.state.location.pathname).toBe(canonicalPath);

	// Short URL with lowercased identifier — should redirect.
	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: teamSlug, taskId: friendly },
	});
	await waitFor(() => {
		expect(router.state.location.pathname).toBe(canonicalPath);
	});
	await findByRole('heading', { name: taskTitle });

	// Short URL with UUID — should redirect.
	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: teamSlug, taskId: taskId },
	});
	await waitFor(() => {
		expect(router.state.location.pathname).toBe(canonicalPath);
	});

	// Project-scoped URL with UUID — should still resolve.
	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: { teamId: teamSlug, projectId: projectSlug, taskId: taskId },
	});
	await findByRole('heading', { name: taskTitle });
});

test('bare ticket identifier renders as a tooltip-ed link and navigates to the target task', async () => {
	let teamSlug = '';
	let projSlugA = '';
	let projSlugB = '';
	let sourceIdentifier = '';
	let targetIdentifier = '';
	const targetTitle = 'Target task title goes here';

	const { findByRole, findByTestId, user, router, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain')!;
			const projA = await seedProject(ws, { name: 'Mention Source' });
			const projB = await seedProject(ws, { name: 'Mention Target' });

			const target = await seedTask(ws, projB, {
				title: targetTitle,
				assignee_id: captain.id,
			});
			const source = await seedTask(ws, projA, {
				title: 'Source task',
				description: `See also ${target.identifier} for related work.`,
				assignee_id: captain.id,
			});
			teamSlug = ws.team.slug;
			projSlugA = projA.slug;
			projSlugB = projB.slug;
			targetIdentifier = target.identifier;
			sourceIdentifier = source.identifier;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: {
			teamId: teamSlug,
			projectId: projSlugA,
			taskId: sourceIdentifier.toLowerCase(),
		},
	});

	await findByRole('heading', { name: 'Source task' });

	const mentionLink = await findByTestId('task-mention-link');
	expect(mentionLink.textContent).toContain(targetIdentifier);

	await user.click(mentionLink);

	await findByRole('heading', { name: targetTitle });
	const targetPath = `/teams/${teamSlug}/projects/${projSlugB}/tasks/${targetIdentifier.toLowerCase()}`;
	expect(router.state.location.pathname).toBe(targetPath);
});

test('right sidebar houses the Effort control while wake-assignee lives in the comment form', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Sidebar Project' });
			const task = await seedTask(ws, project, {
				title: 'Sidebar Test Task',
			});
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

	const sidebar = await findByTestId('task-sidebar');
	const effort = sidebar.querySelector(
		'[aria-label="Reasoning effort for the agent run triggered by this comment"]',
	);
	expect(effort).toBeTruthy();

	const wakeCheckboxInSidebar = sidebar.querySelector(
		'input[type="checkbox"][aria-label="Wake assignee on submit"]',
	);
	expect(wakeCheckboxInSidebar).toBeNull();
});

test('Progress Summary and Rules cards expose info icons with help text', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Tooltip Project' });
			const task = await seedTask(ws, project, {
				title: 'Tooltip Test Task',
			});
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

	const progressInfo = await findByTestId('progress-summary-info', undefined, {
		timeout: 10_000,
	});
	expect(progressInfo.getAttribute('aria-label')).toBe('About Progress Summary');

	const rulesInfo = await findByTestId('rules-info');
	expect(rulesInfo.getAttribute('aria-label')).toBe('About Rules');

	const progressCard = await findByTestId('pinned-progress-summary');
	expect(progressCard.textContent).toContain('Progress Summary');
	const progressEdit = Array.from(progressCard.querySelectorAll('button')).find(
		(b) => b.textContent === 'Edit',
	);
	expect(progressEdit).toBeTruthy();

	const rulesCard = await findByTestId('pinned-rules');
	expect(rulesCard.textContent).toContain('Rules');
	const rulesEdit = Array.from(rulesCard.querySelectorAll('button')).find(
		(b) => b.textContent === 'Edit',
	);
	expect(rulesEdit).toBeTruthy();
});
