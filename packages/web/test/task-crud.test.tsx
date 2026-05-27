import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function lockTask(
	headers: { Authorization: string; 'Content-Type': string },
	teamId: string,
	taskId: string,
	memberId: string,
) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/teams/${teamId}/tasks/${taskId}/lock`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ member_id: memberId }),
	});
	if (!res.ok) throw new Error(`Failed to lock task: ${res.status} ${await res.text()}`);
}

test('can create a task with required assignee', async () => {
	const seeded = { teamSlug: '' };
	const { findByRole, findByLabelText, router, user, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Test Project' });
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks',
		params: { teamId: seeded.teamSlug },
	});

	const newTaskBtn = await findByRole('button', { name: /New task/i });
	await user.click(newTaskBtn);

	const titleInput = await findByLabelText('Title');
	await user.type(titleInput, 'Test Task');

	// The "More" disclosure (Priority + Project) is open by default when no
	// defaultProjectId is passed in. Wait for the React Query that fills the
	// project select to populate. The dialog is rendered into a Radix portal
	// (document.body), so `container.querySelector` from the test root would
	// miss it; query document.body directly.
	await waitFor(
		() => {
			const optionsText = Array.from(document.body.querySelectorAll('option')).map(
				(o) => o.textContent,
			);
			expect(optionsText).toContain('Test Project');
		},
		{ timeout: 5000 },
	);

	// Dialog renders into a Radix portal, so all <select>s live on document.body.
	const selects = Array.from(document.body.querySelectorAll('select')) as HTMLSelectElement[];
	const projectSel = selects.find((s) =>
		Array.from(s.options).some((o) => o.text === 'Test Project'),
	)!;
	const assigneeSel = selects.find((s) =>
		Array.from(s.options).some((o) => o.text === 'Select assignee'),
	)!;

	const projectOption = Array.from(projectSel.options).find((o) => o.text === 'Test Project')!;
	await user.selectOptions(projectSel, projectOption.value);

	const createBtn = (await findByRole('button', { name: 'Create' })) as HTMLButtonElement;
	expect(createBtn.disabled).toBe(true);

	const assigneeOption = Array.from(assigneeSel.options).find((o) => o.value !== '')!;
	await user.selectOptions(assigneeSel, assigneeOption.value);

	expect(createBtn.disabled).toBe(false);
	await user.click(createBtn);

	const heading = await findByRole('heading', { name: 'Test Task' });
	expect(heading).toBeTruthy();
});

test('task detail shows execution lock banner when locked', async () => {
	const seeded = { teamSlug: '', taskId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (_ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Lock Project' });
			const task = await seedTask(ws, project, { title: 'Locked Task' });
			await lockTask(ws.headers, ws.team.id, task.id, ws.agents[0].id);
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
	});

	const runningLine = await findByTestId('running-agents-line');
	expect(runningLine.textContent).toContain('is running');
});

test('task detail lists every agent running concurrently on a ticket', async () => {
	const seeded = {
		teamSlug: '',
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
			await lockTask(ws.headers, ws.team.id, task.id, ws.agents[0].id);
			await lockTask(ws.headers, ws.team.id, task.id, ws.agents[1].id);
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
			seeded.firstTitle = ws.agents[0].title;
			seeded.secondTitle = ws.agents[1].title;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
	});

	const runningLine = await findByTestId('running-agents-line');
	expect(runningLine.textContent).toContain('are running');
	expect(runningLine.textContent).toContain(seeded.firstTitle);
	expect(runningLine.textContent).toContain(seeded.secondTitle);
	expect(runningLine.textContent).toContain(' and ');
});

test('can edit task rules and progress summary', async () => {
	const seeded = { teamSlug: '', taskId: '' };
	const { findByTestId, findByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Rules Project' });
			const task = await seedTask(ws, project, { title: 'Rules Test Task' });
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
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
	const seeded = { teamSlug: '', taskId: '' };
	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Markdown Project' });
			const task = await seedTask(ws, project, { title: 'Markdown Task' });
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
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
	const seeded = { teamSlug: '', taskId: '', agentTitle: '' };
	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Assignee Project' });
			const task = await seedTask(ws, project, { title: 'Assignee Badge Task' });
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
			seeded.agentTitle = ws.agents[0].title;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
	});

	const sidebar = await findByTestId('task-sidebar');
	expect(sidebar.textContent).toContain(seeded.agentTitle);

	// Status badge should be one of Idle / Running / Paused. Scope the query
	// to the assignee chip — the sidebar agent rail also surfaces "Idle" text
	// for every agent in the team and would otherwise match first.
	const assignee = await findByTestId('task-assignee');
	expect(assignee.textContent ?? '').toMatch(/Idle|Running|Paused/);
});

test('can change assignee via popover dropdown', async () => {
	const seeded = {
		teamSlug: '',
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
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
			seeded.agent1Title = ws.agents[0].title;
			seeded.agent2Title = ws.agents[1].title;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
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
	const seeded = { teamSlug: '', taskId: '', taskTitle: 'Outside Click Task' };
	const { findByTestId, findByRole, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Outside Click Project' });
			const task = await seedTask(ws, project, { title: seeded.taskTitle });
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
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

test('Internal project restricts assignee dropdown to the Captain', async () => {
	const seeded = { teamSlug: '', captainTitle: '', engineerTitle: '' };
	const { findByRole, findByLabelText, router, user, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain')!;
			const engineer = ws.agents.find((a) => a.slug === 'engineer')!;
			expect(captain).toBeTruthy();
			expect(engineer).toBeTruthy();
			seeded.teamSlug = ws.team.slug;
			seeded.captainTitle = captain.title;
			seeded.engineerTitle = engineer.title;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks',
		params: { teamId: seeded.teamSlug },
	});

	const newTaskBtn = await findByRole('button', { name: /New task/i });
	await user.click(newTaskBtn);

	const titleInput = await findByLabelText('Title');
	await user.type(titleInput, 'Internal-only assignee check');

	// Dialog renders into a Radix portal on document.body. Wait for the
	// project list to populate before reading options.
	await waitFor(
		() => {
			const optionsText = Array.from(document.body.querySelectorAll('option')).map(
				(o) => o.textContent,
			);
			expect(optionsText).toContain('(Internal)');
		},
		{ timeout: 5000 },
	);

	const selects = Array.from(document.body.querySelectorAll('select')) as HTMLSelectElement[];
	const projectSel = selects.find((s) =>
		Array.from(s.options).some((o) => o.text === '(Internal)'),
	)!;
	const internalOption = Array.from(projectSel.options).find((o) => o.text === '(Internal)')!;
	await user.selectOptions(projectSel, internalOption.value);

	const refreshedSelects = Array.from(
		document.body.querySelectorAll('select'),
	) as HTMLSelectElement[];
	const assigneeSel = refreshedSelects.find((s) =>
		Array.from(s.options).some(
			(o) => o.text === 'Select assignee' || o.text === seeded.captainTitle,
		),
	)!;
	const labels = Array.from(assigneeSel.options)
		.map((o) => o.text)
		.filter((t) => t !== 'Select assignee');
	expect(labels).toContain(seeded.captainTitle);
	expect(labels).not.toContain(seeded.engineerTitle);
	expect(labels.length).toBe(1);
});

test('task description renders markdown', async () => {
	const seeded = { teamSlug: '', taskId: '' };
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
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
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
		teamSlug: '',
		taskId: '',
		projectName: 'Linkable Project',
		projectSlug: '',
	};
	const { findByRole, router, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: seeded.projectName });
			const task = await seedTask(ws, project, { title: 'Project Link Task' });
			seeded.teamSlug = ws.team.slug;
			seeded.taskId = task.id;
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/tasks/$taskId',
		params: { teamId: seeded.teamSlug, taskId: seeded.taskId },
	});

	await findByRole('heading', { name: 'Project Link Task' });
	const expectedHref = `/teams/${seeded.teamSlug}/projects/${seeded.projectSlug}`;
	const projectLinks = Array.from(container.querySelectorAll('a')).filter(
		(a) => a.textContent === seeded.projectName,
	) as HTMLAnchorElement[];
	// At least two: the badge in main and the metadata in sidebar
	expect(projectLinks.length).toBeGreaterThanOrEqual(2);
	for (const link of projectLinks) {
		expect(link.getAttribute('href')).toBe(expectedHref);
	}
});

test('sidebar shows agent status badges', async () => {
	const seeded = { teamSlug: '' };
	const { router, container } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			seeded.teamSlug = ws.team.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/agents/$agentId',
		params: { teamId: seeded.teamSlug, agentId: 'captain' },
	});

	// The sidebar's Team section lists each agent with an "Idle" badge once
	// the agent runtime status finishes loading. Wait for at least one Idle
	// to appear in the sidebar nav (the main pane also shows Idle after
	// load, but that arrives later).
	await waitFor(
		() => {
			const nav = container.querySelector('nav');
			expect(nav?.textContent ?? '').toContain('Idle');
		},
		{ timeout: 5000 },
	);
});
