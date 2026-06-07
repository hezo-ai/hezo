import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function insertActiveRun(memberId: string, teamId: string, taskId: string) {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running', now())`,
		[memberId, teamId, taskId],
	);
}

test('assignee shows Idle on this ticket when no active heartbeat run is present', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Quiet Project' });
			const task = await seedTask(ws, project, {
				title: 'Quiet Ticket',
				assignee_id: ws.agents[0].id,
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

	const assignee = await findByTestId('task-assignee', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(assignee.textContent).toContain('Idle');
		expect(assignee.textContent).not.toContain('Running');
	});

	expect(assignee.querySelector('[aria-label="Assignee locked: agent is running"]')).toBeNull();

	// Click the dropdown toggle and ensure no transition to Running occurs.
	const toggleBtn = assignee.querySelector('button');
	if (toggleBtn) await user.click(toggleBtn);
	expect(assignee.textContent).not.toContain('Running');
});

test('assignee shows Running on this ticket when has_active_run is true', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Busy Project' });
			const task = await seedTask(ws, project, {
				title: 'Busy Ticket',
				assignee_id: ws.agents[0].id,
			});
			await insertActiveRun(ws.agents[0].id, ws.team.id, task.id);
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

	const assignee = await findByTestId('task-assignee', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(assignee.textContent).toContain('Running');
	});
	expect(assignee.querySelector('[aria-label="Assignee locked: agent is running"]')).not.toBeNull();
});
