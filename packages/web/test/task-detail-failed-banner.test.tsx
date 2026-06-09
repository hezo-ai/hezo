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

async function insertFailedRunWithComment(
	workspace: SeededWorkspace,
	task: SeededTask,
	status: 'failed' | 'timed_out' = 'failed',
): Promise<{ runId: string; commentId: string }> {
	const { db } = getTestContext();
	const agentId = workspace.agents[0].id;
	const runRes = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '1 minute', now())
		 RETURNING id`,
		[agentId, workspace.team.id, task.id, status],
	);
	const runId = runRes.rows[0].id;
	const commentRes = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'run'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[task.id, agentId, JSON.stringify({ run_id: runId, agent_id: agentId })],
	);
	return { runId, commentId: commentRes.rows[0].id };
}

async function insertRunningRun(workspace: SeededWorkspace, task: SeededTask): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
		 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())`,
		[workspace.agents[0].id, workspace.team.id, task.id],
	);
}

test('banner appears when last run failed and jumps to the run comment when clicked', async () => {
	const seeded = { projectSlug: '', taskIdentifier: '', commentId: '' };
	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Failed Task' });
			const { commentId } = await insertFailedRunWithComment(ws, task, 'failed');
			seeded.projectSlug = project.slug;
			seeded.taskIdentifier = task.identifier.toLowerCase();
			seeded.commentId = commentId;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskIdentifier },
	});

	const banner = await findByTestId('last-run-failed-banner', undefined, { timeout: 10_000 });
	expect(banner.textContent).toContain('Last run failed');

	await user.click(banner);

	await waitFor(() => {
		expect(window.location.hash).toBe(`#comment-${seeded.commentId}`);
	});
});

test('banner reports "timed out" copy when the last run timed out', async () => {
	const seeded = { projectSlug: '', taskIdentifier: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Timed Out Task' });
			await insertFailedRunWithComment(ws, task, 'timed_out');
			seeded.projectSlug = project.slug;
			seeded.taskIdentifier = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskIdentifier },
	});

	const banner = await findByTestId('last-run-failed-banner', undefined, { timeout: 10_000 });
	expect(banner.textContent).toContain('timed out');
});

test('banner is hidden when the task has no completed runs', async () => {
	const seeded = { projectSlug: '', taskIdentifier: '' };
	const { findByRole, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Fresh Task' });
			seeded.projectSlug = project.slug;
			seeded.taskIdentifier = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskIdentifier },
	});

	await findByRole('heading', { name: 'Fresh Task' });
	await waitFor(() => {
		expect(queryByTestId('last-run-failed-banner')).toBeNull();
	});
});

test('banner is suppressed while a retry is currently running', async () => {
	const seeded = { projectSlug: '', taskIdentifier: '' };
	const { findByRole, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Retrying Task' });
			await insertFailedRunWithComment(ws, task, 'failed');
			await insertRunningRun(ws, task);
			seeded.projectSlug = project.slug;
			seeded.taskIdentifier = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskIdentifier },
	});

	await findByRole('heading', { name: 'Retrying Task' });
	await waitFor(() => {
		expect(queryByTestId('last-run-failed-banner')).toBeNull();
	});
});
