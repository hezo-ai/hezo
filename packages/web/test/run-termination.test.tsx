import { fireEvent } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

const FAKE_RUN_ID = 'cccc0000-0000-0000-0000-000000000123';

function makeRunComment(opts: { taskId: string; agentId: string }) {
	return {
		id: 'aaaa0000-0000-0000-0000-000000000001',
		task_id: opts.taskId,
		content_type: 'run',
		content: {
			run_id: FAKE_RUN_ID,
			agent_id: opts.agentId,
			agent_title: 'Captain',
		},
		chosen_option: null,
		created_at: '2026-05-25T11:30:40Z',
		author_type: 'agent',
		author_name: 'Captain',
		author_member_id: opts.agentId,
	};
}

function makeRunRow(
	opts: { taskId: string; agentId: string; teamId: string },
	status: 'running' | 'cancelled' | 'succeeded',
) {
	const startedAt = '2026-05-25T11:30:40Z';
	return {
		id: FAKE_RUN_ID,
		member_id: opts.agentId,
		team_id: opts.teamId,
		wakeup_id: null,
		task_id: opts.taskId,
		task_identifier: 'TR-1',
		task_title: 'Terminate Me',
		project_id: null,
		project_slug: null,
		status,
		started_at: startedAt,
		finished_at: status === 'running' ? null : '2026-05-25T11:30:45Z',
		exit_code: status === 'succeeded' ? 0 : status === 'cancelled' ? -1 : null,
		error: status === 'cancelled' ? 'Terminated by user' : null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: null,
		invocation_command: null,
		log_text: '[synthetic] running',
		working_dir: null,
		trigger_source: 'on_demand',
		trigger_payload: null,
		trigger_comment_id: null,
		trigger_actor_member_id: null,
		trigger_actor_slug: null,
		trigger_actor_title: null,
		trigger_comment_task_id: null,
		trigger_comment_task_identifier: null,
		trigger_comment_project_slug: null,
		created_tasks: [],
	};
}

function installMocks(opts: {
	taskId: string;
	agentId: string;
	teamId: string;
	status: 'running' | 'succeeded';
	onTerminate?: () => void;
}) {
	const originalFetch = globalThis.fetch;
	const runComment = makeRunComment(opts);
	let currentRow = makeRunRow(opts, opts.status);

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

		if (method === 'GET' && /\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
			return new Response(JSON.stringify({ data: [runComment] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (
			method === 'GET' &&
			new RegExp(`/api/projects/[^/]+/agents/[^/]+/heartbeat-runs/${FAKE_RUN_ID}$`).test(url)
		) {
			return new Response(JSON.stringify({ data: currentRow }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (
			method === 'POST' &&
			new RegExp(`/api/projects/[^/]+/agents/[^/]+/heartbeat-runs/${FAKE_RUN_ID}/terminate$`).test(
				url,
			)
		) {
			opts.onTerminate?.();
			currentRow = makeRunRow(opts, 'cancelled');
			return new Response(JSON.stringify({ data: { ...currentRow, terminated: true } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return originalFetch(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
}

test('inline run comment shows terminate button and confirms before posting', async () => {
	const seeded = { projectSlug: '', taskId: '' };
	let terminateCalled = false;

	const { findAllByTestId, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Terminate Run Project' });
			const task = await seedTask(ws, project, {
				title: 'Terminate Me',
				assignee_id: captain.id,
			});

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			installMocks({
				taskId: task.id,
				agentId: captain.id,
				teamId: ws.team.id,
				status: 'running',
				onTerminate: () => {
					terminateCalled = true;
				},
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const buttons = await findAllByTestId('terminate-run-button', undefined, { timeout: 20_000 });
	fireEvent.click(buttons[0]);

	const dialog = await findByTestId('confirm-dialog');
	expect(dialog.textContent ?? '').toContain('Terminate this run?');

	const confirmBtn = await findByTestId('confirm-dialog-confirm');
	fireEvent.click(confirmBtn);

	await new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + 15_000;
		const tick = () => {
			if (terminateCalled) return resolve();
			if (Date.now() > deadline) return reject(new Error('Terminate POST not observed'));
			setTimeout(tick, 50);
		};
		tick();
	});
	expect(terminateCalled).toBe(true);
});

test('terminate button is hidden for finished runs', async () => {
	const seeded = { projectSlug: '', taskId: '' };

	const { findByTestId, queryAllByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Terminate Run Project 2' });
			const task = await seedTask(ws, project, {
				title: 'Terminate Me',
				assignee_id: captain.id,
			});

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			installMocks({
				taskId: task.id,
				agentId: captain.id,
				teamId: ws.team.id,
				status: 'succeeded',
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await findByTestId('run-comment', undefined, { timeout: 20_000 });
	// Wait for the heartbeat-run to load so the inline header reflects completion.
	await findByTestId('run-comment-summary', undefined, { timeout: 20_000 });
	expect(queryAllByTestId('terminate-run-button').length).toBe(0);
});
