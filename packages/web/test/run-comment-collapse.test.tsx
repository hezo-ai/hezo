import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';
import { expandEventGroups } from './helpers/thread';

// A run entry in the task feed must be collapsed by default and only auto-expand
// while the run is actively running. The regression this guards: on a virtualized
// feed each scroll remount refires the per-run status query, and while that query
// was loading the entry rendered its log expanded (status defaults to 'queued',
// which read as active) and then collapsed once the run resolved — a visible
// flash. The fix treats the loading/unknown state as non-active (collapsed).

const RUN_ID = 'dddd0000-0000-0000-0000-000000000abc';

type Agent = { id: string; slug: string };
type Seeded = { projectSlug: string; taskId: string };
type Comment = Record<string, unknown>;

function runComment(taskRowId: string, agent: Agent): Comment {
	return {
		id: 'run-collapse-c1',
		task_id: taskRowId,
		content_type: 'run',
		content: { run_id: RUN_ID, agent_id: agent.id, agent_title: 'Captain', agent_slug: agent.slug },
		chosen_option: null,
		created_at: '2026-05-20T11:30:00Z',
		author_type: 'agent',
		author_name: 'Captain',
		author_member_id: agent.id,
	};
}

function runResponse(
	agent: Agent,
	teamId: string,
	taskRowId: string,
	status: string,
): Record<string, unknown> {
	const active = status === 'running' || status === 'queued';
	return {
		id: RUN_ID,
		member_id: agent.id,
		team_id: teamId,
		task_id: taskRowId,
		status,
		started_at: '2026-05-20T11:30:00Z',
		finished_at: active ? null : '2026-05-20T11:30:30Z',
		exit_code: 0,
		error: null,
		input_tokens: 0,
		output_tokens: 0,
		cost_cents: 0,
		log_text: 'run output line',
		created_tasks: [],
	};
}

/** Seed a team/project/task, stub the comments fetch with one run entry, and the
 * per-run status fetch with the given status. `gate`, when supplied, holds the
 * status response until the test resolves it, so the loading window is
 * observable. */
async function setup(opts: { seeded: Seeded; status: string; gate?: Promise<void> }) {
	const { seeded, status, gate } = opts;
	return renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Run Collapse Project' });
			const task = await seedTask(ws, project, {
				title: 'Run Collapse Task',
				assignee_id: captain.id,
			});

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			const comments = [runComment(task.id, captain)];
			const run = runResponse(captain, ws.team.id, task.id, status);

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && /\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
					return new Response(JSON.stringify({ data: comments }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (
					method === 'GET' &&
					/\/api\/projects\/[^/]+\/agents\/[^/]+\/heartbeat-runs\/[^/?]+/.test(url)
				) {
					if (gate) await gate;
					return new Response(JSON.stringify({ data: run }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});
}

test('a completed run stays collapsed while its status is still loading (no flash)', async () => {
	const seeded: Seeded = { projectSlug: '', taskId: '' };
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});

	const { findByTestId, queryByTestId, user, router } = await setup({
		seeded,
		status: 'succeeded',
		gate,
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// The run entry mounts and its header renders before the per-run status query
	// resolves (the gate is still closed). The log body must NOT be shown during
	// this loading window — that transient expand-then-collapse was the flash.
	await expandEventGroups(user);
	await findByTestId('run-comment-header', undefined, { timeout: 20_000 });
	expect(queryByTestId('run-comment-log')).toBeNull();

	// Resolve the status query: a succeeded run stays collapsed by default.
	release();
	await findByTestId('run-comment-summary', undefined, { timeout: 20_000 });
	expect(queryByTestId('run-comment-log')).toBeNull();

	// ...and only expands on an explicit click of the header.
	await user.click(await findByTestId('run-comment-header'));
	await findByTestId('run-comment-log', undefined, { timeout: 20_000 });
});

test('an actively running run shows its log expanded without interaction', async () => {
	const seeded: Seeded = { projectSlug: '', taskId: '' };
	const { findByTestId, queryByTestId, router, user } = await setup({ seeded, status: 'running' });

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	await expandEventGroups(user);

	// Active run: the log body is shown immediately, and there is no collapsed
	// summary row (that only appears once the run has finished).
	await findByTestId('run-comment-log', undefined, { timeout: 20_000 });
	expect(queryByTestId('run-comment-summary')).toBeNull();
});
