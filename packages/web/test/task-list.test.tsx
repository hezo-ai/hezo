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

async function insertActiveRun(memberId: string, teamId: string, taskId: string) {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running', now())`,
		[memberId, teamId, taskId],
	);
}

async function seedAdminMention(ws: SeededWorkspace, taskId: string, text: string) {
	const { db } = getTestContext();
	const userRow = await db.query<{ user_id: string }>(
		`SELECT mu.user_id FROM member_users mu
		 JOIN members m ON m.id = mu.id
		 WHERE m.team_id = $1 AND mu.role = 'admin' LIMIT 1`,
		[ws.team.id],
	);
	const userId = userRow.rows[0]?.user_id;
	if (!userId) throw new Error('seedAdminMention: no admin user on team');
	const comment = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb) RETURNING id`,
		[taskId, ws.agents[0].id, JSON.stringify({ text })],
	);
	await db.query(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
		 VALUES ($1, $2, $3, $4)`,
		[ws.team.id, taskId, comment.rows[0].id, userId],
	);
}

test('default view shows open and done tasks with a collapsed filter bar and New Task button', async () => {
	let projectSlug = '';

	const { findByText, findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Filter Project A' });
			const agentId = ws.agents[0].id;
			const tasks = [];
			for (const title of ['Review Task', 'In Progress Task', 'Done Task', 'Backlog Task']) {
				const t = await seedTask(ws, project, { title, assignee_id: agentId });
				tasks.push(t);
			}
			await patchStatus(ws, tasks[0].id, 'review');
			await patchStatus(ws, tasks[1].id, 'in_progress');
			await patchStatus(ws, tasks[2].id, 'done');
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Review Task', undefined, { timeout: 10_000 });
	await findByText('In Progress Task');
	await findByText('Backlog Task');
	// Done tasks are shown by default now (in the bottom Done section).
	await findByText('Done Task');

	await findByTestId('task-filter-bar');
	expect(queryByTestId('task-filter-panel')).toBeNull();
	await findByTestId('task-list-new-task');
});

test('multi-select status filter narrows results and reset restores defaults', async () => {
	let projectSlug = '';

	const { findByText, findByTestId, findByRole, queryByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Filter Project B' });
			const agentId = ws.agents[0].id;
			const tasks = [];
			for (const title of ['Review Task', 'In Progress Task', 'Done Task', 'Backlog Task']) {
				const t = await seedTask(ws, project, { title, assignee_id: agentId });
				tasks.push(t);
			}
			await patchStatus(ws, tasks[0].id, 'review');
			await patchStatus(ws, tasks[1].id, 'in_progress');
			await patchStatus(ws, tasks[2].id, 'done');
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Review Task', undefined, { timeout: 10_000 });

	const toggle = await findByTestId('task-filter-toggle');
	await user.click(toggle);
	await findByTestId('task-filter-panel');

	const statusBtn = await findByTestId('task-filter-status');
	await user.click(statusBtn);
	// Radix Popover.Portal renders into body
	let clear = await findByRole('button', { name: 'Clear selection' });
	await user.click(clear);
	const doneOption = await findByRole('button', { name: 'Done' });
	await user.click(doneOption);
	// Close popover by clicking the trigger again
	await user.click(statusBtn);

	await waitFor(
		() => {
			expect(queryByText('Done Task')).not.toBeNull();
			expect(queryByText('Backlog Task')).toBeNull();
			// In progress + review stay pinned at the top regardless of the status filter.
			expect(queryByText('In Progress Task')).not.toBeNull();
			expect(queryByText('Review Task')).not.toBeNull();
		},
		{ timeout: 10_000 },
	);

	await user.click(statusBtn);
	clear = await findByRole('button', { name: 'Clear selection' });
	await user.click(clear);
	const backlogOption = await findByRole('button', { name: 'Backlog' });
	await user.click(backlogOption);
	await user.click(statusBtn);

	await waitFor(
		() => {
			expect(queryByText('Backlog Task')).not.toBeNull();
			expect(queryByText('Done Task')).toBeNull();
			// To-do filters do not affect the pinned in-progress section.
			expect(queryByText('In Progress Task')).not.toBeNull();
			expect(queryByText('Review Task')).not.toBeNull();
		},
		{ timeout: 10_000 },
	);

	const resetBtn = await findByTestId('task-filter-reset');
	await user.click(resetBtn);
	await waitFor(
		() => {
			expect(queryByText('Review Task')).not.toBeNull();
			expect(queryByText('In Progress Task')).not.toBeNull();
			expect(queryByText('Backlog Task')).not.toBeNull();
			// Reset restores the default selection, which now includes done.
			expect(queryByText('Done Task')).not.toBeNull();
		},
		{ timeout: 10_000 },
	);
});

test('terminal tasks render in a Done section split out from the Backlog', async () => {
	let projectSlug = '';

	const { findByTestId, findByText, findByRole, queryByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Done Split Project' });
			projectSlug = project.slug;
			const agentId = ws.agents[0].id;
			await seedTask(ws, project, { title: 'Backlog Task', assignee_id: agentId });
			const done = await seedTask(ws, project, { title: 'Done Task', assignee_id: agentId });
			const cancelled = await seedTask(ws, project, {
				title: 'Cancelled Task',
				assignee_id: agentId,
			});
			await patchStatus(ws, done.id, 'done');
			await patchStatus(ws, cancelled.id, 'cancelled');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	// Default view shows done tasks (in their own bottom section) but not cancelled.
	await findByText('Backlog Task', undefined, { timeout: 10_000 });
	const initialDone = await findByTestId('task-list-done');
	expect(initialDone.textContent).toContain('Done Task');
	expect(initialDone.querySelector('h2')?.textContent).toBe('Done');
	expect(queryByText('Cancelled Task')).toBeNull();

	// Add cancelled to the filter so the abandoned work is also fetched.
	const toggle = await findByTestId('task-filter-toggle');
	await user.click(toggle);
	const statusBtn = await findByTestId('task-filter-status');
	await user.click(statusBtn);
	const cancelledOption = await findByRole('button', { name: 'Cancelled' });
	await user.click(cancelledOption);
	await user.click(statusBtn);

	// Both terminal tasks land under "Done"; the Backlog keeps only open work.
	const doneSection = await findByTestId('task-list-done');
	await waitFor(
		() => {
			expect(doneSection.textContent).toContain('Done Task');
			expect(doneSection.textContent).toContain('Cancelled Task');
		},
		{ timeout: 10_000 },
	);
	expect(doneSection.querySelector('h2')?.textContent).toBe('Done');
	expect(doneSection.textContent).not.toContain('Backlog Task');

	const backlogSection = await findByTestId('task-list-main');
	expect(backlogSection.querySelector('h2')?.textContent).toBe('Backlog');
	expect(backlogSection.textContent).toContain('Backlog Task');
	expect(backlogSection.textContent).not.toContain('Done Task');
	expect(backlogSection.textContent).not.toContain('Cancelled Task');

	// Finished work is visually faded (theme-agnostic opacity); open work is not.
	expect(doneSection.querySelector('tbody tr')?.className).toContain('opacity-60');
	expect(backlogSection.querySelector('tbody tr')?.className ?? '').not.toContain('opacity-60');
});

test('Done section orders tasks by last-updated, most recent first', async () => {
	let projectSlug = '';

	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Done Order Project' });
			projectSlug = project.slug;
			const agentId = ws.agents[0].id;
			// Created in order first -> second -> third.
			const first = await seedTask(ws, project, { title: 'First done', assignee_id: agentId });
			const second = await seedTask(ws, project, { title: 'Second done', assignee_id: agentId });
			const third = await seedTask(ws, project, { title: 'Third done', assignee_id: agentId });
			// Move to done in an order that is neither the created order nor its
			// reverse, so `second` is updated last. Each PATCH is a separate awaited
			// transaction, so the updated_at trigger stamps increasing timestamps.
			await patchStatus(ws, first.id, 'done');
			await patchStatus(ws, third.id, 'done');
			await patchStatus(ws, second.id, 'done');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('First done', undefined, { timeout: 10_000 });
	const doneSection = await findByTestId('task-list-done');

	// Expected reverse-chron-by-updated_at order: Second (updated last), Third,
	// First. This differs from created_at desc (Third, Second, First) and
	// created_at asc (First, Second, Third), so it uniquely pins updated_at desc.
	await waitFor(
		() => {
			const titles = Array.from(doneSection.querySelectorAll('tbody tr'))
				.map((r) => r.textContent ?? '')
				.filter((t) => t.includes(' done'));
			const secondIdx = titles.findIndex((t) => t.includes('Second done'));
			const thirdIdx = titles.findIndex((t) => t.includes('Third done'));
			const firstIdx = titles.findIndex((t) => t.includes('First done'));
			expect(secondIdx).toBeGreaterThan(-1);
			expect(thirdIdx).toBeGreaterThan(secondIdx);
			expect(firstIdx).toBeGreaterThan(thirdIdx);
		},
		{ timeout: 10_000 },
	);
});

test('Done section hides when only terminal tasks remain after filtering them out', async () => {
	let projectSlug = '';

	const { findByTestId, findByText, findByRole, queryByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Only Done Project' });
			projectSlug = project.slug;
			const agentId = ws.agents[0].id;
			const done = await seedTask(ws, project, { title: 'Finished Task', assignee_id: agentId });
			await patchStatus(ws, done.id, 'done');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	// Filter to just "Done": only the Done section renders, no empty Backlog header.
	const toggle = await findByTestId('task-filter-toggle');
	await user.click(toggle);
	const statusBtn = await findByTestId('task-filter-status');
	await user.click(statusBtn);
	const clear = await findByRole('button', { name: 'Clear selection' });
	await user.click(clear);
	const doneOption = await findByRole('button', { name: 'Done' });
	await user.click(doneOption);
	await user.click(statusBtn);

	await findByText('Finished Task', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(queryByTestId('task-list-done')).not.toBeNull();
	});
	// No open work matches, so the Backlog section is omitted entirely.
	expect(queryByTestId('task-list-main')).toBeNull();
});

test('filter bar collapses/expands and applies search + sort', async () => {
	let projectSlug = '';

	const { findByText, findByTestId, queryByTestId, queryByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Filter Project C' });
			const agentId = ws.agents[0].id;
			for (const title of ['Authentication bug', 'Payment flow', 'Sign-up form']) {
				await seedTask(ws, project, { title, assignee_id: agentId });
			}
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Payment flow', undefined, { timeout: 10_000 });

	expect(queryByTestId('task-filter-panel')).toBeNull();
	const toggle = await findByTestId('task-filter-toggle');
	await user.click(toggle);
	await findByTestId('task-filter-panel');

	const searchInput = (await findByTestId('task-filter-search')) as HTMLInputElement;
	await user.type(searchInput, 'Payment');

	await waitFor(
		() => {
			expect(queryByText('Payment flow')).not.toBeNull();
			expect(queryByText('Authentication bug')).toBeNull();
			expect(queryByText('Sign-up form')).toBeNull();
		},
		{ timeout: 10_000 },
	);

	const resetBtn = await findByTestId('task-filter-reset');
	await user.click(resetBtn);
	await waitFor(() => {
		expect(searchInput.value).toBe('');
	});

	await findByText('Authentication bug');
	await findByText('Payment flow');
	await findByText('Sign-up form');

	const sortField = (await findByTestId('task-filter-sort-field')) as HTMLSelectElement;
	await user.selectOptions(sortField, 'created_at');
	const sortDir = (await findByTestId('task-filter-sort-dir')) as HTMLSelectElement;
	await user.selectOptions(sortDir, 'asc');

	// After asc-sort, ensure the first visible item is "Authentication bug".
	await waitFor(() => {
		const rows = document.querySelectorAll('tr');
		const titles = Array.from(rows)
			.map((r) => r.textContent ?? '')
			.filter((t) => t.includes('bug') || t.includes('flow') || t.includes('form'));
		expect(titles[0]).toContain('Authentication bug');
	});
});

test('running dot is hidden by default and shown when a heartbeat run is active', async () => {
	let projectSlug = '';

	const { findByText, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Indicator Project' });
			const agentId = ws.agents[0].id;
			await seedTask(ws, project, { title: 'Quiet Task', assignee_id: agentId });
			const busy = await seedTask(ws, project, {
				title: 'Busy Task',
				assignee_id: agentId,
			});
			await insertActiveRun(agentId, ws.team.id, busy.id);
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Quiet Task', undefined, { timeout: 10_000 });
	await findByText('Busy Task');

	await waitFor(() => {
		const dots = container.querySelectorAll('[data-testid="task-running-dot"]');
		expect(dots.length).toBe(1);
	});
});

test('mention notice shows only on tasks with an unread admin mention for the viewer', async () => {
	let projectSlug = '';

	const { findByText, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention Project' });
			const agentId = ws.agents[0].id;
			await seedTask(ws, project, { title: 'No mention task', assignee_id: agentId });
			const mentioned = await seedTask(ws, project, {
				title: 'Mentioned task',
				assignee_id: agentId,
			});
			await seedAdminMention(ws, mentioned.id, '@admin need your call here.');
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Mentioned task', undefined, { timeout: 10_000 });
	await findByText('No mention task');

	// Exactly one row carries the unread-mention notice — the mentioned task.
	await waitFor(() => {
		const notices = container.querySelectorAll('[data-testid="task-mention-notice"]');
		expect(notices.length).toBe(1);
	});
});

test('tasks with active runs pin to the top regardless of sort order', async () => {
	let projectSlug = '';

	const { findByText, container, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Pin Project' });
			const agentId = ws.agents[0].id;
			const old = await seedTask(ws, project, {
				title: 'Old running task',
				assignee_id: agentId,
			});
			// Newer ticket should sort first by created_at desc but the old one
			// has an active run so it should pin above it.
			await seedTask(ws, project, {
				title: 'New idle task',
				assignee_id: agentId,
			});
			await insertActiveRun(agentId, ws.team.id, old.id);
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Old running task', undefined, { timeout: 10_000 });

	await waitFor(() => {
		const rows = Array.from(container.querySelectorAll('tr'))
			.map((r) => r.textContent ?? '')
			.filter((t) => t.includes('task'));
		expect(rows[0]).toContain('Old running task');
	});
});

test('in progress tasks render in a pinned section without duplicating in the main list', async () => {
	let projectSlug = '';

	const { findByTestId, findByText, queryAllByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Split List Project' });
			projectSlug = project.slug;
			const agentId = ws.agents[0].id;
			await seedTask(ws, project, { title: 'Backlog Task', assignee_id: agentId });
			const active = await seedTask(ws, project, {
				title: 'Active Task',
				assignee_id: agentId,
			});
			const review = await seedTask(ws, project, {
				title: 'Review Task',
				assignee_id: agentId,
			});
			await patchStatus(ws, active.id, 'in_progress');
			await patchStatus(ws, review.id, 'review');
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByTestId('task-list-in-progress', undefined, { timeout: 10_000 });
	await findByTestId('task-list-main');
	await findByText('Active Task');
	await findByText('Review Task');
	await findByText('Backlog Task');
	expect(queryAllByText('Active Task')).toHaveLength(1);
	expect(queryAllByText('Review Task')).toHaveLength(1);

	const inProgressSection = await findByTestId('task-list-in-progress');
	const mainSection = await findByTestId('task-list-main');
	expect(inProgressSection.textContent).toContain('Active Task');
	expect(inProgressSection.textContent).toContain('Review Task');
	expect(inProgressSection.textContent).not.toContain('Backlog Task');
	expect(mainSection.textContent).toContain('Backlog Task');
	expect(mainSection.textContent).not.toContain('Active Task');
	expect(mainSection.textContent).not.toContain('Review Task');
});

test('to-do search does not filter the in progress section', async () => {
	let projectSlug = '';

	const { findByTestId, findByText, queryByText, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Search Split Project' });
			projectSlug = project.slug;
			const agentId = ws.agents[0].id;
			const active = await seedTask(ws, project, {
				title: 'Active Alpha',
				assignee_id: agentId,
			});
			await patchStatus(ws, active.id, 'in_progress');
			await seedTask(ws, project, { title: 'Payment flow', assignee_id: agentId });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Active Alpha', undefined, { timeout: 10_000 });
	const toggle = await findByTestId('task-filter-toggle');
	await user.click(toggle);
	const searchInput = (await findByTestId('task-filter-search')) as HTMLInputElement;
	await user.type(searchInput, 'Payment');

	await waitFor(
		() => {
			expect(queryByText('Payment flow')).not.toBeNull();
			expect(queryByText('Active Alpha')).not.toBeNull();
		},
		{ timeout: 10_000 },
	);

	const inProgressSection = await findByTestId('task-list-in-progress');
	expect(inProgressSection.textContent).toContain('Active Alpha');
});

async function seedSubTask(
	ws: SeededWorkspace,
	project: { slug: string },
	parentId: string,
	title: string,
	assigneeId: string,
) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${project.slug}/tasks/${parentId}/sub-tasks`, {
		method: 'POST',
		headers: ws.headers,
		body: JSON.stringify({ title, assignee_id: assigneeId }),
	});
	if (!res.ok) throw new Error(`seedSubTask failed: ${res.status} ${await res.text()}`);
	return ((await res.json()) as { data: { id: string } }).data;
}

test('sub-tasks render indented beneath their parent in in progress and to do sections', async () => {
	let projectSlug = '';
	let ws!: SeededWorkspace;
	let project!: { slug: string };

	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const seededProject = await seedProject(ws, { name: 'Hierarchy Project' });
			project = seededProject;
			projectSlug = seededProject.slug;
			const agentId = ws.agents[0].id;

			const activeParent = await seedTask(ws, seededProject, {
				title: 'Active parent',
				assignee_id: agentId,
			});
			await patchStatus(ws, activeParent.id, 'in_progress');
			const activeChild = await seedSubTask(
				ws,
				seededProject,
				activeParent.id,
				'Active sub-task',
				agentId,
			);
			await patchStatus(ws, activeChild.id, 'in_progress');

			const backlogParent = await seedTask(ws, seededProject, {
				title: 'Backlog parent',
				assignee_id: agentId,
			});
			await seedSubTask(ws, seededProject, backlogParent.id, 'Backlog sub-task', agentId);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Active parent', undefined, { timeout: 10_000 });
	await findByText('Active sub-task');
	await findByText('Backlog parent');
	await findByText('Backlog sub-task');

	const inProgressSection = await findByTestId('task-list-in-progress');
	const inProgressBodyRows = Array.from(inProgressSection.querySelectorAll('tbody tr'));
	const activeParentIdx = inProgressBodyRows.findIndex((r) =>
		r.textContent?.includes('Active parent'),
	);
	const activeChildIdx = inProgressBodyRows.findIndex((r) =>
		r.textContent?.includes('Active sub-task'),
	);
	expect(activeParentIdx).toBeGreaterThan(-1);
	expect(activeChildIdx).toBeGreaterThan(activeParentIdx);
	expect(inProgressBodyRows[activeChildIdx]?.getAttribute('data-depth')).toBe('1');

	const mainSection = await findByTestId('task-list-main');
	const todoBodyRows = Array.from(mainSection.querySelectorAll('tbody tr'));
	const backlogParentIdx = todoBodyRows.findIndex((r) => r.textContent?.includes('Backlog parent'));
	const backlogChildIdx = todoBodyRows.findIndex((r) =>
		r.textContent?.includes('Backlog sub-task'),
	);
	expect(backlogParentIdx).toBeGreaterThan(-1);
	expect(backlogChildIdx).toBeGreaterThan(backlogParentIdx);
	expect(todoBodyRows[backlogChildIdx]?.getAttribute('data-depth')).toBe('1');
});

// The nesting cap is 3, so the deepest legal sub-task sits three levels below its
// root. Each level needs its own indent class: falling back to the parent's makes
// the two deepest levels read as siblings.
test('a full-depth sub-task chain indents every level distinctly', async () => {
	let projectSlug = '';

	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Deep Hierarchy Project' });
			projectSlug = project.slug;
			const agentId = ws.agents[0].id;

			const root = await seedTask(ws, project, { title: 'Deep root', assignee_id: agentId });
			const level1 = await seedSubTask(ws, project, root.id, 'Deep level one', agentId);
			const level2 = await seedSubTask(ws, project, level1.id, 'Deep level two', agentId);
			await seedSubTask(ws, project, level2.id, 'Deep level three', agentId);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	await findByText('Deep root', undefined, { timeout: 10_000 });
	await findByText('Deep level three');

	const section = await findByTestId('task-list-main');
	const rows = Array.from(section.querySelectorAll('tbody tr'));
	const rowFor = (title: string) => {
		const row = rows.find((r) => r.textContent?.includes(title));
		if (!row) throw new Error(`no row for ${title}`);
		return row;
	};

	expect(rowFor('Deep root').getAttribute('data-depth')).toBeNull();
	expect(rowFor('Deep level one').getAttribute('data-depth')).toBe('1');
	expect(rowFor('Deep level two').getAttribute('data-depth')).toBe('2');
	expect(rowFor('Deep level three').getAttribute('data-depth')).toBe('3');

	// Each level's title cell carries a distinct left padding, so the hierarchy is
	// readable rather than two levels sharing one indent.
	// The indent lands on the title column's cell, which is not necessarily the
	// first one, so scan the row for whichever cell carries a pl-* class.
	const indentOf = (title: string) => {
		const cells = Array.from(rowFor(title).querySelectorAll('td'));
		const match = cells.map((c) => c.className.match(/pl-\d+/)?.[0]).find(Boolean);
		if (!match) throw new Error(`no indent class on the row for ${title}`);
		return match;
	};
	const indents = ['Deep level one', 'Deep level two', 'Deep level three'].map(indentOf);
	expect(new Set(indents).size).toBe(3);
});
