import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';
import { expandEventGroups } from './helpers/thread';

async function lockTask(
	headers: { Authorization: string; 'Content-Type': string },
	projectHandle: string,
	taskId: string,
	memberId: string,
) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${projectHandle}/tasks/${taskId}/lock`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ member_id: memberId }),
	});
	if (!res.ok) throw new Error(`Failed to lock task: ${res.status} ${await res.text()}`);
}

test('can create a task with required assignee', async () => {
	const seeded = { projectSlug: '' };
	const { findByRole, findByTestId, findByLabelText, router, user, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Test Project' });
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	// The filter-bar create button is now icon-only; target it by testid (several
	// "New task" affordances — sidebar "+", app-header button — share the label).
	const newTaskBtn = await findByTestId('task-list-new-task');
	await user.click(newTaskBtn);

	const titleInput = await findByLabelText('Title');
	await user.type(titleInput, 'Test Task');

	// The task is created in the project named in the URL — the dialog no longer
	// has a project picker. Wait for the assignee select (populated by the
	// project's agents) to fill. The dialog renders into a Radix portal on
	// document.body, so query there.
	await waitFor(
		() => {
			const optionsText = Array.from(document.body.querySelectorAll('option')).map(
				(o) => o.textContent,
			);
			expect(optionsText).toContain('Select assignee');
		},
		{ timeout: 5000 },
	);

	const selects = Array.from(document.body.querySelectorAll('select')) as HTMLSelectElement[];
	const assigneeSel = selects.find((s) =>
		Array.from(s.options).some((o) => o.text === 'Select assignee'),
	)!;

	const createBtn = (await findByRole('button', { name: 'Create' })) as HTMLButtonElement;
	expect(createBtn.disabled).toBe(true);

	await waitFor(() => {
		expect(Array.from(assigneeSel.options).some((o) => o.value !== '')).toBe(true);
	});
	const assigneeOption = Array.from(assigneeSel.options).find((o) => o.value !== '')!;
	await user.selectOptions(assigneeSel, assigneeOption.value);

	expect(createBtn.disabled).toBe(false);
	await user.click(createBtn);

	const heading = await findByRole('heading', { name: 'Test Task' });
	expect(heading).toBeTruthy();
});

test('task detail shows the running agent in the Agent Queue section when locked', async () => {
	const seeded = { projectSlug: '', taskId: '', agentTitle: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (_ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Lock Project' });
			const task = await seedTask(ws, project, { title: 'Locked Task' });
			await lockTask(ws.headers, project.slug, task.id, ws.agents[0].id);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentTitle = ws.agents[0].title;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const section = await findByTestId('agent-queue-section');
	expect(section.textContent).toContain('Agent Queue');
	expect(section.textContent).toContain(seeded.agentTitle);
});

test('task detail lists every agent running concurrently on a task', async () => {
	const seeded = {
		projectSlug: '',
		taskId: '',
		firstTitle: '',
		secondTitle: '',
	};
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Concurrent Project' });
			const task = await seedTask(ws, project, { title: 'Concurrent Task' });
			expect(ws.agents.length).toBeGreaterThanOrEqual(2);
			await lockTask(ws.headers, project.slug, task.id, ws.agents[0].id);
			await lockTask(ws.headers, project.slug, task.id, ws.agents[1].id);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.firstTitle = ws.agents[0].title;
			seeded.secondTitle = ws.agents[1].title;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const section = await findByTestId('agent-queue-section');
	expect(section.textContent).toContain(seeded.firstTitle);
	expect(section.textContent).toContain(seeded.secondTitle);
});

test('can edit task rules and progress summary', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, findByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Rules Project' });
			const task = await seedTask(ws, project, { title: 'Rules Test Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const rulesSection = await findByTestId('pinned-rules');
	const rulesEditBtn = Array.from(rulesSection.querySelectorAll('button')).find(
		(b) => b.textContent === 'Edit',
	)!;
	await user.click(rulesEditBtn);

	const rulesTextarea = rulesSection.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(rulesTextarea, 'Consult architect before changes');
	const rulesSaveBtn = Array.from(rulesSection.querySelectorAll('button')).find(
		(b) => b.textContent === 'Save',
	)!;
	await user.click(rulesSaveBtn);
	await findByText('Consult architect before changes');

	const summarySection = await findByTestId('pinned-progress-summary');
	const summaryEditBtn = Array.from(summarySection.querySelectorAll('button')).find(
		(b) => b.textContent === 'Edit',
	)!;
	await user.click(summaryEditBtn);

	const summaryTextarea = summarySection.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(summaryTextarea, 'Implementation started');
	const summarySaveBtn = Array.from(summarySection.querySelectorAll('button')).find(
		(b) => b.textContent === 'Save',
	)!;
	await user.click(summarySaveBtn);
	await findByText('Implementation started');
});

test('task rules and progress summary render markdown formatting', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Markdown Project' });
			const task = await seedTask(ws, project, { title: 'Markdown Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const rulesBody =
		'Use **bold** guidance.\n\n- first bullet\n- second bullet\n\nRun `bun test` before merge.';
	const summaryBody = '1. Scaffolded routes\n2. Wired up DB\n3. Added tests';

	const pinnedRules = await findByTestId('pinned-rules');
	const rulesEditBtn = Array.from(pinnedRules.querySelectorAll('button')).find(
		(b) => b.textContent === 'Edit',
	)!;
	await user.click(rulesEditBtn);
	const rulesTa = pinnedRules.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(rulesTa, rulesBody);
	const rulesSaveBtn = Array.from(pinnedRules.querySelectorAll('button')).find(
		(b) => b.textContent === 'Save',
	)!;
	await user.click(rulesSaveBtn);

	// Wait for the markdown to render
	await new Promise((r) => setTimeout(r, 100));
	const refreshedRules = await findByTestId('pinned-rules');
	const strong = refreshedRules.querySelector('strong');
	const codeEl = refreshedRules.querySelector('code');
	const liEls = refreshedRules.querySelectorAll('ul li');
	expect(strong?.textContent).toBe('bold');
	expect(codeEl?.textContent).toBe('bun test');
	expect(Array.from(liEls).some((li) => li.textContent === 'first bullet')).toBe(true);
	expect(Array.from(liEls).some((li) => li.textContent === 'second bullet')).toBe(true);

	const pinnedSummary = await findByTestId('pinned-progress-summary');
	const summaryEditBtn = Array.from(pinnedSummary.querySelectorAll('button')).find(
		(b) => b.textContent === 'Edit',
	)!;
	await user.click(summaryEditBtn);
	const summaryTa = pinnedSummary.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(summaryTa, summaryBody);
	const summarySaveBtn = Array.from(pinnedSummary.querySelectorAll('button')).find(
		(b) => b.textContent === 'Save',
	)!;
	await user.click(summarySaveBtn);

	await new Promise((r) => setTimeout(r, 100));
	const refreshedSummary = await findByTestId('pinned-progress-summary');
	const olLis = refreshedSummary.querySelectorAll('ol li');
	const liTexts = Array.from(olLis).map((li) => li.textContent ?? '');
	expect(liTexts).toContain('Scaffolded routes');
	expect(liTexts).toContain('Wired up DB');
	expect(liTexts).toContain('Added tests');
});

test('task detail shows assignee with status badge', async () => {
	const seeded = { projectSlug: '', taskId: '', agentTitle: '' };
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Assignee Project' });
			const task = await seedTask(ws, project, { title: 'Assignee Badge Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentTitle = ws.agents[0].title;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const sidebar = await findByTestId('task-sidebar');
	expect(sidebar.textContent).toContain(seeded.agentTitle);

	// Status badge should be one of Idle / Running / Paused. Scope the query to
	// the assignee chip (the badge variant) — other agent labels on the page use
	// their own treatment (e.g. the sidebar rail's status dot) and shouldn't match.
	const assignee = await findByTestId('task-assignee');
	expect(assignee.textContent ?? '').toMatch(/Idle|Running|Paused/);
});

test('can change assignee via popover dropdown', async () => {
	const seeded = {
		projectSlug: '',
		taskId: '',
		agent1Title: '',
		agent2Title: '',
	};
	const { findByTestId, router, user, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Change Assignee Project' });
			const task = await seedTask(ws, project, {
				title: 'Change Assignee Task',
				assignee_id: ws.agents[0].id,
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agent1Title = ws.agents[0].title;
			seeded.agent2Title = ws.agents[1].title;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const assigneeBox = await findByTestId('task-assignee');
	const toggleBtn = assigneeBox.querySelector('button') as HTMLButtonElement;
	await user.click(toggleBtn);

	// The dropdown is .absolute inside the assigneeBox
	const dropdown = assigneeBox.querySelector('.absolute');
	expect(dropdown).toBeTruthy();
	expect(dropdown!.textContent).toContain(seeded.agent2Title);

	// Click the option matching agent2
	const agent2Btn = Array.from(dropdown!.querySelectorAll('button')).find((b) =>
		b.textContent?.includes(seeded.agent2Title),
	);
	expect(agent2Btn).toBeTruthy();
	await user.click(agent2Btn as HTMLButtonElement);

	// Dropdown closes
	expect(assigneeBox.querySelector('.absolute')).toBeNull();
	// Display reflects new assignee
	await new Promise((r) => setTimeout(r, 50));
	const refreshed = await findByTestId('task-assignee');
	expect(refreshed.textContent).toContain(seeded.agent2Title);
});

test('assignee dropdown closes on outside click and has no unassign option', async () => {
	const seeded = { projectSlug: '', taskId: '', taskTitle: 'Outside Click Task' };
	const { findByTestId, findByRole, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Outside Click Project' });
			const task = await seedTask(ws, project, { title: seeded.taskTitle });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const assigneeBox = await findByTestId('task-assignee');
	const toggleBtn = assigneeBox.querySelector('button') as HTMLButtonElement;
	await user.click(toggleBtn);

	const dropdown = assigneeBox.querySelector('.absolute');
	expect(dropdown).toBeTruthy();
	expect(dropdown!.textContent).not.toContain('Unassigned');

	// Click the heading outside the dropdown
	const heading = await findByRole('heading', { name: seeded.taskTitle });
	// Use pointerDown directly because the close handler listens for pointerdown
	heading.dispatchEvent(new Event('pointerdown', { bubbles: true }));

	await new Promise((r) => setTimeout(r, 50));
	expect(assigneeBox.querySelector('.absolute')).toBeNull();
});

test('can rename a task from the header, and Escape abandons the edit', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, findByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Rename Project' });
			const task = await seedTask(ws, project, { title: 'Original title' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// Escape leaves the stored title alone.
	await user.click(await findByTestId('task-title-edit'));
	const escapeInput = (await findByTestId('task-title-input')) as HTMLInputElement;
	await user.clear(escapeInput);
	await user.type(escapeInput, 'Discarded title{Escape}');
	expect((await findByTestId('task-title')).textContent).toBe('Original title');

	await user.click(await findByTestId('task-title-edit'));
	const input = (await findByTestId('task-title-input')) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, 'Renamed in place{Enter}');

	expect((await findByTestId('task-title')).textContent).toBe('Renamed in place');
	// And the rename lands in the thread as a meta comment.
	// The rename entry is a system row, so it folds in the default Conversation
	// view; this test is about the entry being written at all.
	await expandEventGroups(user);
	await findByText(/renamed from/i, undefined, { timeout: 10_000 });
});

test('can add a description on a task that has none, then edit it', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, findByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Describe Project' });
			const task = await seedTask(ws, project, { title: 'Undescribed Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// The card renders even with no description — it is the only way to add one.
	const card = await findByTestId('task-description-card');
	await findByTestId('task-description-empty');

	await user.click(await findByTestId('task-description-edit'));
	const textarea = card.querySelector('textarea') as HTMLTextAreaElement;
	await user.type(textarea, 'A freshly written body.');
	const save = Array.from(card.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
	await user.click(save);

	await findByText('A freshly written body.');
	// The description-change entry is a system row, so it folds in the default
	// Conversation view; this test is about the entry being written at all.
	await expandEventGroups(user);
	await findByText(/added a description/i, undefined, { timeout: 10_000 });

	await user.click(await findByTestId('task-description-edit'));
	const second = card.querySelector('textarea') as HTMLTextAreaElement;
	await user.clear(second);
	await user.type(second, 'A replacement body.');
	const saveAgain = Array.from(card.querySelectorAll('button')).find(
		(b) => b.textContent === 'Save',
	)!;
	await user.click(saveAgain);

	await findByText('A replacement body.');
	await expandEventGroups(user);
	await findByText(/updated the description/i, undefined, { timeout: 10_000 });
});

test('task description renders markdown', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	const description = [
		'# Heading One',
		'',
		'- bullet item',
		'',
		'[a link](https://example.com)',
		'',
		'```',
		'const x = 1;',
		'```',
	].join('\n');

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Markdown Desc Project' });
			const task = await seedTask(ws, project, {
				title: 'Markdown Description Task',
				description,
			});
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const desc = await findByTestId('task-description');
	expect(desc.querySelector('h1')?.textContent).toBe('Heading One');
	const liItems = desc.querySelectorAll('li');
	expect(Array.from(liItems).some((li) => li.textContent?.includes('bullet item'))).toBe(true);
	const link = Array.from(desc.querySelectorAll('a')).find((a) => a.textContent === 'a link');
	expect(link?.getAttribute('href')).toBe('https://example.com');
	expect(desc.querySelector('pre code')?.textContent).toContain('const x = 1;');
});

test('project badge and metadata label both link to the project page', async () => {
	const seeded = {
		projectSlug: '',
		taskId: '',
		projectName: 'Linkable Project',
	};
	const { findByRole, router, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: seeded.projectName });
			const task = await seedTask(ws, project, { title: 'Project Link Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByRole('heading', { name: 'Project Link Task' });
	// Project landing is the dashboard (index redirects there; sidebar title links there).
	const expectedHref = `/projects/${seeded.projectSlug}/dashboard`;
	const projectLinks = Array.from(container.querySelectorAll('a')).filter(
		(a) => a.textContent === seeded.projectName,
	) as HTMLAnchorElement[];
	// At least two: the project-menu title and the metadata in the task sidebar
	expect(projectLinks.length).toBeGreaterThanOrEqual(2);
	for (const link of projectLinks) {
		expect(link.getAttribute('href')).toBe(expectedHref);
	}
});

test('project menu Team section lists the team agents', async () => {
	const seeded = { projectSlug: '' };
	const { router, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	// The project menu's Team section lists each agent once it finishes loading.
	// Runtime status now shows as a dot indicator (pulsing for running, none for
	// idle) rather than a text suffix, so wait on an agent name to confirm load.
	await waitFor(
		() => {
			const nav = container.querySelector('nav[aria-label="Sidebar"]');
			expect(nav?.textContent ?? '').toContain('Captain');
		},
		{ timeout: 15_000 },
	);
});
