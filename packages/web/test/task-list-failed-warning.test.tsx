import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededTask,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

async function insertCompletedRun(
	workspace: SeededWorkspace,
	task: SeededTask,
	status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '1 minute', now())`,
		[workspace.agents[0].id, workspace.team.id, task.id, status],
	);
}

async function insertRunningRun(workspace: SeededWorkspace, task: SeededTask): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())`,
		[workspace.agents[0].id, workspace.team.id, task.id],
	);
}

test('failed last run shows the warning icon in the task list', async () => {
	const seeded = { projectSlug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Failed Task' });
			await insertCompletedRun(ws, task, 'failed');
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	await findByTestId('task-failed-warning', undefined, { timeout: 10_000 });
});

test('successful last run does not show the warning', async () => {
	const seeded = { projectSlug: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Done Task' });
			await insertCompletedRun(ws, task, 'succeeded');
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	await findByTestId('task-filter-bar', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(queryByTestId('task-failed-warning')).toBeNull();
	});
});

test('cancelled last run does not show the warning', async () => {
	const seeded = { projectSlug: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Cancelled Task' });
			await insertCompletedRun(ws, task, 'cancelled');
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	await findByTestId('task-filter-bar', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(queryByTestId('task-failed-warning')).toBeNull();
	});
});

test('active retry suppresses the failed-run warning', async () => {
	const seeded = { projectSlug: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Retrying Task' });
			await insertCompletedRun(ws, task, 'failed');
			await insertRunningRun(ws, task);
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	await findByTestId('task-running-dot', undefined, { timeout: 10_000 });
	await waitFor(() => {
		expect(queryByTestId('task-failed-warning')).toBeNull();
	});
});

test('timed_out last run also shows the warning', async () => {
	const seeded = { projectSlug: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Timed Out Task' });
			await insertCompletedRun(ws, task, 'timed_out');
			seeded.projectSlug = project.slug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks',
		params: { projectId: seeded.projectSlug },
	});

	await findByTestId('task-failed-warning', undefined, { timeout: 10_000 });
});
