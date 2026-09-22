// What the execution detail page's Usage card has to admit about a figure.
//
// A run the server killed mid-flight is marked failed with a partial usage
// snapshot (usage_partial = true). The card must say so rather than passing the
// number off as a final total.
// Render-driven (no real layout / viewport / WebSocket), so this lives in the
// component tier; the run + agent responses are fetch-mocked the same way as
// agent-executions-project.test.tsx.

import { afterEach, expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

const RUN_ID = 'dddd0000-0000-0000-0000-0000000000b2';

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
	runOverrides?: Record<string, unknown>;
}) {
	const agent = {
		id: opts.agentId,
		team_id: opts.teamId,
		display_name: opts.agentSlug,
		title: 'Captain',
		slug: opts.agentSlug,
		summary: 'Agent summary.',
		role_description: '',
		team_context: '',
		default_effort: 'medium',
		heartbeat_interval_min: 60,
		run_timeout_min: 60,
		daily_budget_tokens: 0,
		weekly_budget_tokens: 0,
		monthly_budget_tokens: 30_000_000,
		touches_code: false,
		runtime_status: 'active',
		admin_status: 'enabled',
		is_instance: false,
		reports_to: null,
		reports_to_title: null,
		assigned_task_count: 0,
		model_override_provider: null,
		model_override_model: null,
		created_at: new Date().toISOString(),
	};

	const defaultRun = {
		id: RUN_ID,
		member_id: opts.agentId,
		team_id: opts.teamId,
		wakeup_id: null,
		task_id: opts.taskId,
		task_identifier: 'TO-16',
		task_title: 'Fix 37 e2e test failures',
		project_id: '99999999-9999-9999-9999-999999999999',
		project_slug: 'demo',
		project_name: 'Demo',
		status: 'failed',
		queued_reason: null,
		started_at: '2026-06-21T14:50:38Z',
		finished_at: '2026-06-21T15:12:10Z',
		exit_code: -1,
		error: 'Server restarted while run in flight',
		input_tokens: 1_200_000,
		output_tokens: 30_000,
		usage_partial: true,
		invocation_command: null,
		log_text: 'run log output',
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
		model: null,
	};
	const run = { ...defaultRun, ...opts.runOverrides };

	const original = globalThis.fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
	};
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

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

async function renderRunDetail(runOverrides?: Record<string, unknown>) {
	const seeded = { projectSlug: '', agentId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Anchor', assignee_id: captain.id });
			seeded.projectSlug = project.slug;
			seeded.agentId = captain.id;
			installMocks({
				agentId: captain.id,
				agentSlug: 'captain',
				teamId: ws.team.id,
				taskId: task.id,
				runOverrides,
			});
		},
	});

	await helpers.router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions/$runId',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentId, runId: RUN_ID },
	});
	return helpers;
}

test('interrupted run shows its partial usage, prefixed "~" and tagged interrupted', async () => {
	const { findByText, findByTestId } = await renderRunDetail();

	// The partial-snapshot indicator and the "~"-prefixed total both render only
	// when usage_partial is true.
	await findByText('interrupted', undefined, { timeout: 20_000 });
	const tokens = await findByTestId('run-tokens');
	expect(tokens.textContent).toBe('~1.2M tokens');
	// The token split is shown (not a 0/0 placeholder), with the partial "~".
	expect(document.body.textContent).toContain('~1,200,000 in · 30,000 out tokens');
});

test('a finished run shows its total without the partial marks, and names its model', async () => {
	const { findByTestId, queryByText } = await renderRunDetail({
		usage_partial: false,
		model: 'gpt-5-codex',
	});

	const tokens = await findByTestId('run-tokens', undefined, { timeout: 20_000 });
	expect(tokens.textContent).toBe('1.2M tokens');
	expect(queryByText('interrupted')).toBeNull();
	const model = await findByTestId('run-model');
	expect(model.textContent).toBe('gpt-5-codex');
});
