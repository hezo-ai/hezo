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

test('default view shows non-terminal tasks with status badges and a collapsed filter bar with New Task button', async () => {
	let projectSlug = '';

	const { findByText, findByTestId, queryByTestId, queryByText, router } = await renderApp({
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
	expect(queryByText('Done Task')).toBeNull();

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
			expect(queryByText('Done Task')).toBeNull();
		},
		{ timeout: 10_000 },
	);
});

test('terminal tasks render in a Done section split out from the Backlog', async () => {
	let projectSlug = '';

	const { findByTestId, findByText, findByRole, queryByTestId, queryByText, router, user } =
		await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Done Split Project' });
				projectSlug = project.slug;
				const agentId = ws.agents[0].id;
				await seedTask(ws, project, { title: 'Backlog Task', assignee_id: agentId });
				const done = await seedTask(ws, project, { title: 'Done Task', assignee_id: agentId });
				const closed = await seedTask(ws, project, { title: 'Closed Task', assignee_id: agentId });
				await patchStatus(ws, done.id, 'done');
				await patchStatus(ws, closed.id, 'closed');
			},
		});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: projectSlug },
	});

	// Default view excludes terminal statuses, so the Done section is absent.
	await findByText('Backlog Task', undefined, { timeout: 10_000 });
	expect(queryByTestId('task-list-done')).toBeNull();
	expect(queryByText('Done Task')).toBeNull();
	expect(queryByText('Closed Task')).toBeNull();

	// Add the terminal statuses to the filter so the finished work is fetched.
	const toggle = await findByTestId('task-filter-toggle');
	await user.click(toggle);
	const statusBtn = await findByTestId('task-filter-status');
	await user.click(statusBtn);
	const doneOption = await findByRole('button', { name: 'Done' });
	await user.click(doneOption);
	const closedOption = await findByRole('button', { name: 'Closed' });
	await user.click(closedOption);
	await user.click(statusBtn);

	// Terminal tasks land under "Done"; the Backlog keeps only open work.
	const doneSection = await findByTestId('task-list-done');
	await waitFor(
		() => {
			expect(doneSection.textContent).toContain('Done Task');
			expect(doneSection.textContent).toContain('Closed Task');
		},
		{ timeout: 10_000 },
	);
	expect(doneSection.querySelector('h2')?.textContent).toBe('Done');
	expect(doneSection.textContent).not.toContain('Backlog Task');

	const backlogSection = await findByTestId('task-list-main');
	expect(backlogSection.querySelector('h2')?.textContent).toBe('Backlog');
	expect(backlogSection.textContent).toContain('Backlog Task');
	expect(backlogSection.textContent).not.toContain('Done Task');
	expect(backlogSection.textContent).not.toContain('Closed Task');
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
				title: 'Old running ticket',
				assignee_id: agentId,
			});
			// Newer ticket should sort first by created_at desc but the old one
			// has an active run so it should pin above it.
			await seedTask(ws, project, {
				title: 'New idle ticket',
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

	await findByText('Old running ticket', undefined, { timeout: 10_000 });

	await waitFor(() => {
		const rows = Array.from(container.querySelectorAll('tr'))
			.map((r) => r.textContent ?? '')
			.filter((t) => t.includes('ticket'));
		expect(rows[0]).toContain('Old running ticket');
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
