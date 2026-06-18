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
): Promise<{ runId: string; commentId: string; commentPublicId: string }> {
	const { db } = getTestContext();
	const agentId = workspace.agents[0].id;
	const runRes = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at, finished_at)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, now() - interval '1 minute', now())
		 RETURNING id`,
		[agentId, workspace.team.id, task.id, status],
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

test('banner Retry button retries the last failed run even when no run_failed comment exists', async () => {
	// Reproduces the 3+ consecutive-failure case: the `run_failed` ping (which
	// hosts the inline Retry button) is suppressed, so only the `run` comment
	// remains. The banner must still expose a working manual-retry path.
	const seeded = { projectSlug: '', taskIdentifier: '', runId: '' };
	const retryCalls: string[] = [];

	const { findByTestId, queryByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Crash Loop Task' });
			const { runId } = await insertFailedRunWithComment(ws, task, 'failed');
			seeded.projectSlug = project.slug;
			seeded.taskIdentifier = task.identifier.toLowerCase();
			seeded.runId = runId;

			// Intercept the retry POST so we assert on the call without driving a
			// real container dispatch; everything else falls through to the
			// in-process backend so the task GET returns a real `last_run_id`.
			const passthrough = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				const retryMatch = url.match(/\/api\/projects\/[^/]+\/tasks\/[^/]+\/runs\/([^/]+)\/retry/);
				if (method === 'POST' && retryMatch) {
					retryCalls.push(retryMatch[1]);
					return new Response(JSON.stringify({ data: { dispatched: true } }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return passthrough(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskIdentifier },
	});

	const retryButton = (await findByTestId('retry-failed-run-banner', undefined, {
		timeout: 10_000,
	})) as HTMLButtonElement;
	// No inline run_failed retry in this scenario — the banner is the only path.
	expect(queryByTestId('retry-failed-run')).toBeNull();

	await user.click(retryButton);

	await waitFor(() => {
		expect(retryCalls).toEqual([seeded.runId]);
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
