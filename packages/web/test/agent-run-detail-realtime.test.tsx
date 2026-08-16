import { HeartbeatRunKind, RunOutcomeFilter } from '@hezo/shared';
import { queryClient } from '@hezo/web/lib/query-client';
import { afterEach, expect, test } from 'vitest';
import type { HeartbeatRun } from '../src/hooks/use-heartbeat-runs';
import { invalidateQueriesForRowChange } from '../src/hooks/use-websocket';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

/**
 * The run detail page has to reflect a run going terminal while it is open.
 *
 * A run parked waiting for container capacity sits `queued` for minutes, and the
 * thing that ends it is a server-side sweep, not anything the reader did. If the
 * page does not pick that up, the operator is left staring at "Waiting to
 * start…" for a run that already finished, and has to reload to find out what
 * happened - which is exactly what was reported.
 */

let restoreFetch: (() => void) | null = null;
afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
});

function makeRun(overrides: Partial<HeartbeatRun>): HeartbeatRun {
	return {
		id: 'run-1',
		member_id: 'm-1',
		team_id: 't-1',
		wakeup_id: null,
		task_id: 'task-1',
		kind: HeartbeatRunKind.Task,
		task_identifier: 'INV-8',
		task_title: 'Standing watch',
		project_id: 'p-1',
		project_slug: 'demo',
		project_name: 'Demo',
		status: 'queued',
		queued_reason: null,
		created_at: '2024-01-01T00:00:00.000Z',
		started_at: null,
		finished_at: null,
		exit_code: null,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: null,
		usage_partial: false,
		invocation_command: null,
		log_text: null,
		working_dir: null,
		trigger_source: null,
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

/** Serves whatever `current.run` holds, so a test can flip it mid-render. */
function installRunDetailMock(agentId: string, current: { run: HeartbeatRun }) {
	const original = globalThis.fetch;
	restoreFetch = () => {
		globalThis.fetch = original;
	};
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : (input as Request).url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		if (
			method === 'GET' &&
			new RegExp(`/api/projects/[^/]+/agents/${agentId}/heartbeat-runs/[^/?]+`).test(url)
		) {
			return new Response(JSON.stringify({ data: current.run }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return original(input as RequestInfo, init);
	}) as typeof fetch;
}

test('a run going terminal server-side reaches the open detail page without a reload', async () => {
	const current = { run: makeRun({}) };
	const seeded = { projectSlug: '', agentId: '', memberId: '' };

	const { router, findByText } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Realtime Project' });
			seeded.projectSlug = project.slug;
			seeded.agentId = captain.id;
			seeded.memberId = captain.id;
			current.run = makeRun({ member_id: captain.id, project_slug: project.slug });
			installRunDetailMock(captain.id, current);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions/$runId',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentId, runId: 'run-1' },
		search: { filter: RunOutcomeFilter.Errored },
	});

	// Parked: no start time, so the page says so and shows no error.
	await findByText('Waiting to start…', undefined, { timeout: 20_000 });

	// The sweep runs. The row goes terminal and the server broadcasts the change
	// with the payload the orphan detector actually sends.
	current.run = makeRun({
		member_id: seeded.memberId,
		project_slug: seeded.projectSlug,
		status: 'cancelled',
		finished_at: '2024-01-01T00:05:00.000Z',
		error: 'Never started: no host process was driving this run.',
	});
	invalidateQueriesForRowChange(queryClient, seeded.projectSlug, 'heartbeat_runs', {
		id: 'run-1',
		member_id: seeded.memberId,
		task_id: 'task-1',
		project_id: 'p-1',
		status: 'cancelled',
	});

	await findByText(/Never started/, undefined, { timeout: 20_000 });
});

test('the back link returns to the filtered view the reader came from', async () => {
	const current = { run: makeRun({ status: 'failed', error: 'Boom' }) };
	const seeded = { projectSlug: '', agentId: '' };

	const { router, container, findByText } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Back Link Project' });
			seeded.projectSlug = project.slug;
			seeded.agentId = captain.id;
			current.run = makeRun({
				member_id: captain.id,
				project_slug: project.slug,
				status: 'failed',
				error: 'Boom',
			});
			installRunDetailMock(captain.id, current);
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents/$agentId/executions/$runId',
		params: { projectId: seeded.projectSlug, agentId: seeded.agentId, runId: 'run-1' },
		search: { filter: RunOutcomeFilter.Errored },
	});

	// Wait for the run itself to land, so the back link is the rendered one.
	await findByText(/Boom/, undefined, { timeout: 20_000 });

	// Targeted by testid, not by name: the agent layout renders its own
	// "Executions" folder tab, which points at the unfiltered list and would
	// satisfy a name-based query while telling us nothing about this link.
	//
	// Without the carried filter this href drops `?filter=errored`, landing the
	// reader on a view that need not contain the run they just left.
	const back = container.querySelector('[data-testid="run-back-link"]');
	expect(back?.getAttribute('href')).toContain('filter=errored');
});
