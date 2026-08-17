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
	error: string | null = null,
): Promise<{ runId: string; commentId: string; commentPublicId: string }> {
	const { db } = getTestContext();
	const agentId = workspace.agents[0].id;
	const runRes = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at, error)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '1 minute', now(), $5)
		 RETURNING id`,
		[agentId, workspace.team.id, task.id, status, error],
	);
	const runId = runRes.rows[0].id;
	const commentRes = await db.query<{ id: string; public_id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'run'::comment_content_type, $3::jsonb)
		 RETURNING id, public_id`,
		[task.id, agentId, JSON.stringify({ run_id: runId, agent_id: agentId })],
	);
	return { runId, commentId: commentRes.rows[0].id, commentPublicId: commentRes.rows[0].public_id };
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
			const { commentPublicId } = await insertFailedRunWithComment(ws, task, 'failed');
			seeded.projectSlug = project.slug;
			seeded.taskIdentifier = task.identifier.toLowerCase();
			seeded.commentId = commentPublicId;
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

test('the banner carries the reason, and never an em dash', async () => {
	// The reason lived in exactly one place in the whole app - the run detail page
	// - so a failed task said only that it had failed.
	const seeded = { projectSlug: '', taskIdentifier: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Reason Task' });
			await insertFailedRunWithComment(
				ws,
				task,
				'failed',
				'This run cannot be prepared: adapter declared env-var bearer storage\nsecond line',
			);
			seeded.projectSlug = project.slug;
			seeded.taskIdentifier = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskIdentifier },
	});

	const banner = await findByTestId('last-run-failed-banner', undefined, { timeout: 10_000 });
	expect(banner.textContent).toContain('This run cannot be prepared');
	// Only the first line: the stored value is multi-line by design.
	expect(banner.textContent).not.toContain('second line');
	expect(banner.textContent).not.toMatch(/[\u2013\u2014]/);
});

test('the banner falls back to the bare label when the run recorded no reason', async () => {
	const seeded = { projectSlug: '', taskIdentifier: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Bare Task' });
			await insertFailedRunWithComment(ws, task, 'timed_out', null);
			seeded.projectSlug = project.slug;
			seeded.taskIdentifier = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskIdentifier },
	});

	const banner = await findByTestId('last-run-failed-banner', undefined, { timeout: 10_000 });
	expect(banner.textContent).toContain('Last run timed out');
});
