import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { clickUntil, getTestContext, renderApp } from './helpers/render';
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
	const res = await apiBase(`/api/projects/${ws.internalSlug}/tasks/${parentId}/sub-tasks`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ title: input.title, assignee_id: assigneeId }),
	});
	if (!res.ok) throw new Error(`createSubTask failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { data: SeededSubTask }).data;
}

test('UI surfaces the depth-cap error when creating a sub-task under a depth-3 task', async () => {
	let projectSlug = '';
	let deepestIdentifier = '';

	const { findByRole, findByTestId, findByLabelText, findByText, user, router } = await renderApp({
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
			const deepest = await createSubTask(ws, subSub.id, {
				title: 'Depth Sub-Sub-Sub',
				assignee_id: engineer.id,
			});
			projectSlug = project.slug;
			deepestIdentifier = deepest.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: projectSlug,
			taskId: deepestIdentifier.toLowerCase(),
		},
	});

	await findByRole('heading', { name: 'Depth Sub-Sub-Sub' });

	// The inline quick-add is gone — "+ Add" now opens the tailored create-task
	// dialog, which requires an assignee, so we must pick one to enable submit.
	await user.click(await findByTestId('sub-tasks-add'));

	const titleInput = await findByLabelText('Title');
	await user.type(titleInput, 'Should be rejected');

	// The dialog renders into a Radix portal on document.body; find the assignee
	// select and pick its first real option (mirrors task-crud.test.tsx).
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

	// The server checks sub-task depth (services/tasks.ts) before the assignee,
	// so it rejects with the depth-cap error and the dialog stays open to show it.
	expect(await findByText(/3 levels deep/)).toBeTruthy();
});

test('canonical task URL is project-scoped; UUID and wrong-project forms redirect', async () => {
	let internalSlug = '';
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
			internalSlug = ws.internalSlug;
			projectSlug = project.slug;
			taskIdentifier = task.identifier;
			taskId = task.id;
		},
	});

	const friendly = taskIdentifier.toLowerCase();
	const canonicalPath = `/projects/${projectSlug}/tasks/${friendly}`;

	// Canonical (project slug + friendly id) stays put.
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: friendly },
	});
	await findByRole('heading', { name: taskTitle });
	expect(router.state.location.pathname).toBe(canonicalPath);

	// UUID id under the canonical project — redirects to the friendly id.
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: taskId },
	});
	await waitFor(() => {
		expect(router.state.location.pathname).toBe(canonicalPath);
	});
	await findByRole('heading', { name: taskTitle });

	// Wrong project handle (same team's internal project) — redirects to the
	// task's canonical project + friendly id.
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: internalSlug, taskId: friendly },
	});
	await waitFor(() => {
		expect(router.state.location.pathname).toBe(canonicalPath);
	});
	await findByRole('heading', { name: taskTitle });
});

test('bare task identifier renders as a tooltip-ed link and navigates to the target task', async () => {
	let projSlug = '';
	let sourceIdentifier = '';
	let targetIdentifier = '';
	const targetTitle = 'Target task title goes here';

	const { findByRole, findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			// Mention resolution is team-scoped. Under 1:1 teams↔projects a team
			// holds exactly one project, so the source and its referenced target
			// task live in the same project.
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain')!;
			const project = await seedProject(ws, { name: 'Mention Project' });

			const target = await seedTask(ws, project, {
				title: targetTitle,
				assignee_id: captain.id,
			});
			const source = await seedTask(ws, project, {
				title: 'Source task',
				description: `See also ${target.identifier} for related work.`,
				assignee_id: captain.id,
			});
			projSlug = project.slug;
			targetIdentifier = target.identifier;
			sourceIdentifier = source.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: projSlug,
			taskId: sourceIdentifier.toLowerCase(),
		},
	});

	await findByRole('heading', { name: 'Source task' });

	const mentionLink = await findByTestId('task-mention-link');
	expect(mentionLink.textContent).toContain(targetIdentifier);

	const targetPath = `/projects/${projSlug}/tasks/${targetIdentifier.toLowerCase()}`;
	await clickUntil(
		user,
		() => document.querySelector('[data-testid="task-mention-link"]'),
		() => router.state.location.pathname === targetPath,
		{ label: 'the task mention link' },
	);

	await findByRole('heading', { name: targetTitle });
	expect(router.state.location.pathname).toBe(targetPath);
});

test('right sidebar houses the Effort control while the wake preview lives in the comment form', async () => {
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
		to: '/projects/$projectId/tasks/$taskId',
		params: {
			projectId: projectSlug,
			taskId: taskIdentifier.toLowerCase(),
		},
	});

	const sidebar = await findByTestId('task-sidebar');
	const effort = sidebar.querySelector(
		'[aria-label="Reasoning effort for the agent run triggered by this comment"]',
	);
	expect(effort).toBeTruthy();

	// The wake preview belongs to the comment composer, not the sidebar.
	expect(sidebar.querySelector('[data-testid="wake-preview"]')).toBeNull();
	const preview = await findByTestId('wake-preview');
	expect(preview.textContent).toContain('Wake:');
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
		to: '/projects/$projectId/tasks/$taskId',
		params: {
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
	// Agent-owned: the card reads, so it carries no Edit affordance.
	const progressEdit = Array.from(progressCard.querySelectorAll('button')).find(
		(b) => b.textContent === 'Edit',
	);
	expect(progressEdit).toBeUndefined();

	const rulesCard = await findByTestId('pinned-rules');
	expect(rulesCard.textContent).toContain('Rules');
	const rulesEdit = Array.from(rulesCard.querySelectorAll('button')).find(
		(b) => b.textContent === 'Edit',
	);
	expect(rulesEdit).toBeTruthy();
});

test('Progress Summary and Rules cards are collapsed by default and toggle open', async () => {
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Collapse Project' });
			const task = await seedTask(ws, project, { title: 'Collapse Test Task' });
			projectSlug = project.slug;
			taskIdentifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: taskIdentifier.toLowerCase() },
	});

	// Collapsed by default: header/label is visible but the body content is not.
	const progressCard = await findByTestId('pinned-progress-summary', undefined, {
		timeout: 10_000,
	});
	const progressToggle = await findByTestId('progress-summary-toggle');
	expect(progressToggle.getAttribute('aria-expanded')).toBe('false');
	expect(progressCard.textContent).not.toContain('No progress summary yet.');

	const rulesCard = await findByTestId('pinned-rules');
	const rulesToggle = await findByTestId('rules-toggle');
	expect(rulesToggle.getAttribute('aria-expanded')).toBe('false');
	expect(rulesCard.textContent).not.toContain('No rules set.');

	// Clicking the toggle expands the body.
	await user.click(progressToggle);
	expect(progressToggle.getAttribute('aria-expanded')).toBe('true');
	expect((await findByTestId('pinned-progress-summary')).textContent).toContain(
		'No progress summary yet.',
	);

	await user.click(rulesToggle);
	expect(rulesToggle.getAttribute('aria-expanded')).toBe('true');
	expect((await findByTestId('pinned-rules')).textContent).toContain('No rules set.');

	// Clicking again collapses it back.
	await user.click(progressToggle);
	expect(progressToggle.getAttribute('aria-expanded')).toBe('false');
	expect((await findByTestId('pinned-progress-summary')).textContent).not.toContain(
		'No progress summary yet.',
	);
});
