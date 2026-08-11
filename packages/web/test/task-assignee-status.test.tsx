import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function insertActiveRun(
	memberId: string,
	teamId: string,
	taskId: string,
	opts: { status?: 'running' | 'queued'; queuedReason?: string } = {},
) {
	const { status = 'running', queuedReason = null } = opts;
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, queued_reason)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, $5, $6)`,
		[
			memberId,
			teamId,
			taskId,
			status,
			status === 'running' ? new Date().toISOString() : null,
			queuedReason,
		],
	);
}

test('assignee shows Idle on this task when no active heartbeat run is present', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Quiet Project' });
			const task = await seedTask(ws, project, {
				title: 'Quiet Task',
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

test('assignee shows Running on this task when has_active_run is true', async () => {
	let teamSlug = '';
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Busy Project' });
			const task = await seedTask(ws, project, {
				title: 'Busy Task',
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

test('assignee shows Queued, not Running, while the run has yet to start', async () => {
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Waiting Project' });
			const task = await seedTask(ws, project, {
				title: 'Waiting Task',
				assignee_id: ws.agents[0].id,
			});
			await insertActiveRun(ws.agents[0].id, ws.team.id, task.id, {
				status: 'queued',
				queuedReason: 'waiting for prior run on this credential',
			});
			projectSlug = project.slug;
			taskIdentifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: taskIdentifier.toLowerCase() },
	});

	const assignee = await findByTestId('task-assignee', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(assignee.textContent).toContain('Queued');
	});
	expect(assignee.textContent).not.toContain('Running');

	// Still locked — the server 409s on a queued run too — but the tooltip says why.
	const lock = assignee.querySelector('[aria-label="Assignee locked: run queued"]');
	expect(lock).not.toBeNull();
	expect(assignee.querySelector('[aria-label="Change assignee"]')).toBeNull();
});

test('assignee stays Idle when the active run belongs to a different agent', async () => {
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Shared Project' });
			const task = await seedTask(ws, project, {
				title: 'Shared Task',
				assignee_id: ws.agents[0].id,
			});
			// A second agent (a reviewer, say) is the one running on the task.
			const other = ws.agents.find((a) => a.id !== ws.agents[0].id);
			if (!other) throw new Error('expected the roster to hold more than one agent');
			await insertActiveRun(other.id, ws.team.id, task.id);
			projectSlug = project.slug;
			taskIdentifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: taskIdentifier.toLowerCase() },
	});

	const assignee = await findByTestId('task-assignee', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(
			assignee.querySelector('[aria-label="Assignee locked: another agent is running"]'),
		).not.toBeNull();
	});
	// The pill describes the assignee, and the assignee is not the one running.
	expect(assignee.textContent).toContain('Idle');
	expect(assignee.textContent).not.toContain('Running');
	expect(assignee.querySelector('[aria-label="Change assignee"]')).toBeNull();
});
