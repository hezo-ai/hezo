// CEO/Coach are instance agents that run tasks across every project, so their
// execution pages surface which project each task lives in. Render-driven (no
// real layout/viewport/WebSocket), so this lives in the component tier. The run
// + agent responses are fetch-mocked (same pattern as run-created-tasks /
// run-termination) because constructing a realistic cross-project run against
// the real backend is impractical; the server returns project_name is covered
// by packages/server/test/heartbeat-runs.test.ts.

import { afterEach, expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

const RUN_ID = 'dddd0000-0000-0000-0000-0000000000a1';

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

function installMocks(opts: {
	agentId: string;
	agentSlug: string;
	teamId: string;
	taskId: string;
}) {
	const agent = {
		id: opts.agentId,
		team_id: opts.teamId,
		display_name: opts.agentSlug,
		title: opts.agentSlug === 'ceo' ? 'CEO' : 'Captain',
		slug: opts.agentSlug,
		summary: 'Agent summary.',
		role_description: '',
		team_context: '',
		default_effort: 'medium',
		heartbeat_interval_min: 60,
		run_timeout_min: 60,
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 3000,
		touches_code: false,
		runtime_status: 'active',
		admin_status: 'enabled',
		is_instance: opts.agentSlug === 'ceo',
		reports_to: null,
		reports_to_title: null,
		assigned_task_count: 0,
		model_override_provider: null,
		model_override_model: null,
		created_at: new Date().toISOString(),
	};

	// The run's task lives in a *different* project than the page's route, the way
	// a real CEO/Coach cross-team run does.
	const run = {
		id: RUN_ID,
		member_id: opts.agentId,
		team_id: opts.teamId,
		wakeup_id: null,
		task_id: opts.taskId,
		task_identifier: 'ACME-12',
		task_title: 'Review team coherence after roster change',
		project_id: '99999999-9999-9999-9999-999999999999',
		project_slug: 'acme-robotics',
		project_name: 'Acme Robotics',
		status: 'succeeded',
		queued_reason: null,
		started_at: '2026-06-07T20:58:30Z',
		finished_at: '2026-06-07T20:59:50Z',
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		invocation_command: null,
		log_text: 'done',
		working_dir: null,
		trigger_source: 'assignment',
		trigger_payload: null,
		trigger_comment_id: null,
		trigger_actor_member_id: null,
		trigger_actor_slug: null,
		trigger_actor_title: null,
		trigger_comment_task_id: null,
		trigger_comment_task_identifier: null,
		trigger_comment_project_slug: null,
		run_comment_id: null,
		created_tasks: [],
		created_docs: [],
		created_skills: [],
		proposed_skills: [],
	};

	const original = globalThis.fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
	};
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

		// Short-circuit the app shell's update check so the in-process server never
		// reaches out to GitHub (keeps the run network-free and the log quiet).
		if (method === 'GET' && /\/api\/updates\/latest$/.test(url)) {
			return new Response(
				JSON.stringify({
					data: { current: '0.0.0', latest: null, updateAvailable: false, url: null },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}

		if (
			method === 'GET' &&
			new RegExp(`/api/projects/[^/]+/agents/[^/]+/heartbeat-runs/${RUN_ID}$`).test(url)
		) {
			return new Response(JSON.stringify({ data: run }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		if (
			method === 'GET' &&
			new RegExp(`/api/projects/[^/]+/agents/${opts.agentId}(\\?.*)?$`).test(url)
		) {
			return new Response(JSON.stringify({ data: agent }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return original(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
}

test('CEO run-detail page shows the task project as a suffix on the task link', async () => {
	const seeded = { projectSlug: '', agentId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Home Project' });
			const task = await seedTask(ws, project, { title: 'Anchor', assignee_id: captain.id });
			seeded.projectSlug = project.slug;
			seeded.agentId = captain.id;
			installMocks({ agentId: captain.id, agentSlug: 'ceo', teamId: ws.team.id, taskId: task.id });
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions/$runId',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentId, runId: RUN_ID },
	});

	const suffix = await findByTestId('run-task-project', undefined, { timeout: 20_000 });
	expect(suffix.textContent).toContain('Acme Robotics');
});

test('non-instance agent run-detail page omits the task project suffix', async () => {
	const seeded = { projectSlug: '', agentId: '' };
	const { findByTestId, queryByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Plain Project' });
			const task = await seedTask(ws, project, { title: 'Anchor', assignee_id: captain.id });
			seeded.projectSlug = project.slug;
			seeded.agentId = captain.id;
			installMocks({
				agentId: captain.id,
				agentSlug: 'captain',
				teamId: ws.team.id,
				taskId: task.id,
			});
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions/$runId',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentId, runId: RUN_ID },
	});

	// The triggered-by line renders as soon as the run loads, so once it's present
	// the task line has rendered too — and must carry no project suffix.
	await findByTestId('run-trigger-reason', undefined, { timeout: 20_000 });
	expect(queryByTestId('run-task-project')).toBeNull();
});
