// Coverage for the agent Executions *list* page
// (routes/projects/$projectId/agents/$agentId/executions/index.tsx) — the row
// renderer, the instance-agent project suffix, cost / exit-code / status
// rendering, and the empty + loading states. Render-driven (no real layout,
// viewport, or WebSocket), so it lives in the component tier. The heartbeat-runs
// list is fetch-mocked (same pattern as agent-executions-project.test.tsx)
// because synthesising a realistic multi-run history against the real backend is
// impractical; the server's own list shape is covered by
// packages/server/test/heartbeat-runs.test.ts.

import { INSTANCE_AGENT_SLUGS } from '@hezo/shared';
import { afterEach, expect, test } from 'vitest';
import type { HeartbeatRun } from '../src/hooks/use-heartbeat-runs';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

function makeRun(overrides: Partial<HeartbeatRun>): HeartbeatRun {
	return {
		id: 'run-default',
		member_id: 'm-1',
		team_id: 't-1',
		wakeup_id: null,
		task_id: 'task-1',
		kind: 'task',
		task_identifier: 'DEMO-1',
		task_title: 'Do the thing',
		project_id: 'p-1',
		project_slug: 'demo',
		project_name: 'Demo Project',
		status: 'succeeded',
		queued_reason: null,
		started_at: '2026-06-07T20:58:30Z',
		finished_at: '2026-06-07T20:59:50Z',
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		usage_partial: false,
		invocation_command: null,
		log_text: null,
		working_dir: null,
		trigger_source: 'assignment',
		trigger_payload: null,
		trigger_comment_id: null,
		trigger_comment_public_id: null,
		trigger_actor_member_id: null,
		trigger_actor_slug: null,
		trigger_actor_title: null,
		trigger_comment_task_id: null,
		trigger_comment_task_identifier: null,
		trigger_comment_project_slug: null,
		run_comment_id: null,
		run_comment_public_id: null,
		created_tasks: [],
		created_docs: [],
		created_skills: [],
		proposed_skills: [],
		...overrides,
	};
}

/**
 * Override the heartbeat-runs *list* endpoint (and, for instance-agent tests,
 * the agent slug) so the page renders against a known set of runs. Everything
 * else (the agent layout's own useAgent fetch, the project shell) goes to the
 * real in-process server.
 */
function installRunsListMock(opts: {
	agentId: string;
	runs: HeartbeatRun[];
	agentSlugOverride?: string;
}) {
	const original = globalThis.fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
	};
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

		if (
			method === 'GET' &&
			new RegExp(`/api/projects/[^/]+/agents/${opts.agentId}/heartbeat-runs(\\?.*)?$`).test(url)
		) {
			return new Response(JSON.stringify({ data: opts.runs }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Rewrite the agent's own slug so the page treats it as an instance agent
		// (CEO/Coach) without needing a real instance member in the DB.
		if (
			opts.agentSlugOverride &&
			method === 'GET' &&
			new RegExp(`/api/projects/[^/]+/agents/${opts.agentId}(\\?.*)?$`).test(url)
		) {
			const res = await original(input as RequestInfo, init);
			const body = (await res.json()) as { data?: { slug?: string } };
			if (body.data) body.data.slug = opts.agentSlugOverride;
			return new Response(JSON.stringify(body), {
				status: res.status,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return original(input as RequestInfo, init);
	}) as typeof globalThis.fetch;
}

async function renderExecutions(runs: HeartbeatRun[], opts?: { agentSlugOverride?: string }) {
	const seeded = { projectSlug: '', agentId: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Exec List Project' });
			seeded.projectSlug = project.slug;
			seeded.agentId = captain.id;
			installRunsListMock({
				agentId: captain.id,
				runs: runs.map((r) => ({ ...r, member_id: captain.id })),
				agentSlugOverride: opts?.agentSlugOverride,
			});
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentId },
	});
	return { ...helpers, seeded };
}

test('renders a succeeded run row with status badge, task identifier+title, and links to the run detail', async () => {
	const { findByRole, seeded } = await renderExecutions([
		makeRun({ id: 'run-1', status: 'succeeded', task_identifier: 'DEMO-7', task_title: 'Ship it' }),
	]);

	// The row is a link to the run-detail route. The whole row text is the
	// accessible name, so match by a substring regex.
	const row = await findByRole('link', { name: /DEMO-7/ }, { timeout: 20_000 });
	expect(row.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/agents/${seeded.agentId}/executions/run-1`,
	);
	expect(row.textContent).toContain('succeeded');
	expect(row.textContent).toContain('Ship it');
});

test('a non-zero exit code and a non-zero cost are surfaced on the row', async () => {
	const { findByText } = await renderExecutions([
		makeRun({
			id: 'run-2',
			status: 'failed',
			exit_code: 137,
			cost_cents: 425,
			task_identifier: 'DEMO-9',
		}),
	]);

	// $4.25 from cost_cents=425, and the exit code suffix.
	await findByText('$4.25', undefined, { timeout: 20_000 });
	await findByText('exit: 137');
});

test('a running row shows the pulsing dot via the queued/running status and reads "queued" when not yet started', async () => {
	const { findByRole } = await renderExecutions([
		makeRun({
			id: 'run-3',
			status: 'queued',
			started_at: null,
			finished_at: null,
			task_identifier: 'DEMO-3',
		}),
	]);

	const row = await findByRole('link', { name: /DEMO-3/ }, { timeout: 20_000 });
	expect(row.textContent).toContain('queued');
	// The animated indicator span renders for queued/running rows.
	expect(row.querySelector('.animate-pulse')).not.toBeNull();
});

test("an instance agent (CEO) surfaces the run's own project as a suffix on the task line", async () => {
	// Sanity: captain is the seeded agent we override the slug for; confirm 'ceo'
	// is actually treated as an instance slug so the assertion below is meaningful.
	expect((INSTANCE_AGENT_SLUGS as readonly string[]).includes('ceo')).toBe(true);

	const { findByTestId } = await renderExecutions(
		[
			makeRun({
				id: 'run-4',
				task_identifier: 'ACME-12',
				task_title: 'Cross-project review',
				project_name: 'Acme Robotics',
				project_slug: 'acme-robotics',
			}),
		],
		{ agentSlugOverride: 'ceo' },
	);

	const suffix = await findByTestId('run-row-project', undefined, { timeout: 20_000 });
	expect(suffix.textContent).toContain('Acme Robotics');
});

test('a non-instance agent omits the project suffix even when the run carries a project name', async () => {
	const { findByRole, queryByTestId } = await renderExecutions([
		makeRun({
			id: 'run-5',
			task_identifier: 'DEMO-5',
			project_name: 'Some Project',
			project_slug: 'some-project',
		}),
	]);

	await findByRole('link', { name: /DEMO-5/ }, { timeout: 20_000 });
	expect(queryByTestId('run-row-project')).toBeNull();
});

test('shows the empty state when the agent has no runs', async () => {
	const { findByText } = await renderExecutions([]);
	await findByText('No executions yet.', undefined, { timeout: 20_000 });
});

test('a cancelled run renders with the neutral status (no exit/cost suffixes)', async () => {
	const { findByRole } = await renderExecutions([
		makeRun({
			id: 'run-6',
			status: 'cancelled',
			exit_code: null,
			cost_cents: 0,
			task_identifier: 'DEMO-6',
		}),
	]);

	const row = await findByRole('link', { name: /DEMO-6/ }, { timeout: 20_000 });
	expect(row.textContent).toContain('cancelled');
	// exit_code null and cost 0 → neither the exit-code nor the $ suffix renders.
	expect(row.textContent).not.toContain('exit:');
	expect(row.textContent).not.toContain('$');
});
