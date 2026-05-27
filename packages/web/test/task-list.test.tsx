import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function patchStatus(ws: SeededWorkspace, taskId: string, status: string) {
	const { apiBase } = getTestContext();
	const res = await apiBase(`/api/teams/${ws.team.id}/tasks/${taskId}`, {
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

test('default view shows non-terminal tasks with status badges and a collapsed filter bar with New Task button', async () => {
	let teamSlug = '';
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
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: teamSlug, projectId: projectSlug },
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
	let teamSlug = '';
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
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: teamSlug, projectId: projectSlug },
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
			expect(queryByText('Review Task')).toBeNull();
			expect(queryByText('Backlog Task')).toBeNull();
		},
		{ timeout: 10_000 },
	);

	await user.click(statusBtn);
	clear = await findByRole('button', { name: 'Clear selection' });
	await user.click(clear);
	const inProgressOption = await findByRole('button', { name: 'In Progress' });
	await user.click(inProgressOption);
	await user.click(statusBtn);

	await waitFor(
		() => {
			expect(queryByText('In Progress Task')).not.toBeNull();
			expect(queryByText('Done Task')).toBeNull();
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

test('filter bar collapses/expands and applies search + sort', async () => {
	let teamSlug = '';
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
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: teamSlug, projectId: projectSlug },
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
	let teamSlug = '';
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
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: teamSlug, projectId: projectSlug },
	});

	await findByText('Quiet Task', undefined, { timeout: 10_000 });
	await findByText('Busy Task');

	await waitFor(() => {
		const dots = container.querySelectorAll('[data-testid="task-running-dot"]');
		expect(dots.length).toBe(1);
	});
});

test('tasks with active runs pin to the top regardless of sort order', async () => {
	let teamSlug = '';
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
			teamSlug = ws.team.slug;
			projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/teams/$teamId/projects/$projectId/tasks',
		params: { teamId: teamSlug, projectId: projectSlug },
	});

	await findByText('Old running ticket', undefined, { timeout: 10_000 });

	await waitFor(() => {
		const rows = Array.from(container.querySelectorAll('tr'))
			.map((r) => r.textContent ?? '')
			.filter((t) => t.includes('ticket'));
		expect(rows[0]).toContain('Old running ticket');
	});
});
