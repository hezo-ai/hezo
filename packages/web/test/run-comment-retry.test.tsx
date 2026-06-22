import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// The Retry button on a failed run-entry comment. It must appear only for the
// latest run and only when nothing is already running or queued for the task —
// `retryableRunId` (computed in comments-section) encodes both, and the run's
// own status (fetched per run) decides failed vs succeeded.

const FAILED_RUN_ID = 'cccc0000-0000-0000-0000-000000000111';
const LATER_RUN_ID = 'cccc0000-0000-0000-0000-000000000222';

type Agent = { id: string; slug: string };
type Seeded = { projectSlug: string; taskId: string; agentSlug: string };
type Comment = Record<string, unknown>;

function runComment(
	id: string,
	taskRowId: string,
	runId: string,
	agent: Agent,
	createdAt: string,
): Comment {
	return {
		id,
		task_id: taskRowId,
		content_type: 'run',
		content: { run_id: runId, agent_id: agent.id, agent_title: 'Captain', agent_slug: agent.slug },
		chosen_option: null,
		created_at: createdAt,
		author_type: 'agent',
		author_name: 'Captain',
		author_member_id: agent.id,
	};
}

function runFailedPing(
	id: string,
	taskRowId: string,
	runId: string,
	agent: Agent,
	createdAt: string,
): Comment {
	return {
		id,
		task_id: taskRowId,
		content_type: 'system',
		content: {
			kind: 'run_failed',
			run_id: runId,
			status: 'failed',
			error: 'later boom',
			member_id: agent.id,
			agent_slug: agent.slug,
		},
		chosen_option: null,
		created_at: createdAt,
		author_type: 'admin',
		author_name: 'Admin',
		author_member_id: null,
	};
}

function runResponse(
	runId: string,
	agent: Agent,
	teamId: string,
	taskRowId: string,
	status: string,
): Record<string, unknown> {
	const failed = status === 'failed' || status === 'timed_out';
	return {
		id: runId,
		member_id: agent.id,
		team_id: teamId,
		task_id: taskRowId,
		status,
		started_at: '2026-05-20T11:30:00Z',
		finished_at: '2026-05-20T11:30:30Z',
		exit_code: failed ? 1 : 0,
		error: failed ? 'boom' : null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		log_text: 'output',
		created_tasks: [],
	};
}

async function setup(opts: {
	seeded: Seeded;
	retryCalls: string[];
	comments: (ctx: { task: { id: string }; agent: Agent }) => Comment[];
	runs: (ctx: {
		task: { id: string };
		agent: Agent;
		teamId: string;
	}) => Record<string, Record<string, unknown>>;
	taskOverride?: Record<string, unknown>;
}) {
	const { seeded, retryCalls, comments, runs, taskOverride } = opts;
	return renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Run Retry Project' });
			const task = await seedTask(ws, project, {
				title: 'Run Retry Task',
				assignee_id: captain.id,
			});

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentSlug = captain.slug;

			const commentList = comments({ task, agent: captain });
			const runMap = runs({ task, agent: captain, teamId: ws.team.id });

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

				if (method === 'GET' && /\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
					return new Response(JSON.stringify({ data: commentList }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				const hbMatch = url.match(
					/\/api\/projects\/[^/]+\/agents\/[^/]+\/heartbeat-runs\/([^/?]+)/,
				);
				if (method === 'GET' && hbMatch) {
					const resp = runMap[hbMatch[1]];
					if (resp) {
						return new Response(JSON.stringify({ data: resp }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						});
					}
				}
				if (
					taskOverride &&
					method === 'GET' &&
					/\/api\/projects\/[^/]+\/tasks\/[^/]+(\?|$)/.test(url) &&
					!url.includes('/comments')
				) {
					const res = await originalFetch(input as RequestInfo, init);
					const body = (await res.json()) as { data: Record<string, unknown> };
					return new Response(JSON.stringify({ data: { ...body.data, ...taskOverride } }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				const retryMatch = url.match(/\/api\/projects\/[^/]+\/tasks\/[^/]+\/runs\/([^/]+)\/retry/);
				if (method === 'POST' && retryMatch) {
					retryCalls.push(retryMatch[1]);
					return new Response(JSON.stringify({ data: { dispatched: true } }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});
}

test('failed run-entry comment shows Retry and retries that run on click', async () => {
	const seeded: Seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const retryCalls: string[] = [];

	const { findByTestId, user, router } = await setup({
		seeded,
		retryCalls,
		comments: ({ task, agent }) => [
			runComment('c1', task.id, FAILED_RUN_ID, agent, '2026-05-20T11:30:00Z'),
		],
		runs: ({ task, agent, teamId }) => ({
			[FAILED_RUN_ID]: runResponse(FAILED_RUN_ID, agent, teamId, task.id, 'failed'),
		}),
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const retryButton = (await findByTestId('retry-failed-run', undefined, {
		timeout: 20_000,
	})) as HTMLButtonElement;
	expect(retryButton.textContent ?? '').toContain('Retry');

	await user.click(retryButton);

	await waitFor(() => {
		expect(retryCalls).toEqual([FAILED_RUN_ID]);
	});
});

test('failed run-entry comment hides Retry once a later run supersedes it', async () => {
	const seeded: Seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const retryCalls: string[] = [];

	const { findByTestId, queryByTestId, router } = await setup({
		seeded,
		retryCalls,
		comments: ({ task, agent }) => [
			runComment('c1', task.id, FAILED_RUN_ID, agent, '2026-05-20T11:30:00Z'),
			// A newer run is referenced after it, so FAILED_RUN_ID is no longer latest.
			runFailedPing('c2', task.id, LATER_RUN_ID, agent, '2026-05-20T11:35:00Z'),
		],
		runs: ({ task, agent, teamId }) => ({
			[FAILED_RUN_ID]: runResponse(FAILED_RUN_ID, agent, teamId, task.id, 'failed'),
		}),
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// Wait for the failed run entry to finish loading its status before asserting.
	await findByTestId('run-comment-summary', undefined, { timeout: 20_000 });
	expect(queryByTestId('retry-failed-run')).toBeNull();
});

test('failed run-entry comment hides Retry while a run is active or queued', async () => {
	const seeded: Seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const retryCalls: string[] = [];

	const { findByTestId, queryByTestId, router } = await setup({
		seeded,
		retryCalls,
		comments: ({ task, agent }) => [
			runComment('c1', task.id, FAILED_RUN_ID, agent, '2026-05-20T11:30:00Z'),
		],
		runs: ({ task, agent, teamId }) => ({
			[FAILED_RUN_ID]: runResponse(FAILED_RUN_ID, agent, teamId, task.id, 'failed'),
		}),
		// has_active_run is true for both running and queued runs.
		taskOverride: { has_active_run: true },
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment-summary', undefined, { timeout: 20_000 });
	expect(queryByTestId('retry-failed-run')).toBeNull();
});

test('succeeded run-entry comment shows no Retry button', async () => {
	const seeded: Seeded = { projectSlug: '', taskId: '', agentSlug: '' };
	const retryCalls: string[] = [];

	const { findByTestId, queryByTestId, router } = await setup({
		seeded,
		retryCalls,
		comments: ({ task, agent }) => [
			runComment('c1', task.id, FAILED_RUN_ID, agent, '2026-05-20T11:30:00Z'),
		],
		runs: ({ task, agent, teamId }) => ({
			[FAILED_RUN_ID]: runResponse(FAILED_RUN_ID, agent, teamId, task.id, 'succeeded'),
		}),
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment-summary', undefined, { timeout: 20_000 });
	expect(queryByTestId('retry-failed-run')).toBeNull();
});
