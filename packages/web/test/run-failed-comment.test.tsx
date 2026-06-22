import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

const FAILED_RUN_ID = 'bbbb0000-0000-0000-0000-000000000777';

type Seeded = {
	teamId: string;
	projectSlug: string;
	taskId: string;
	agentId: string;
	agentSlug: string;
};

type Comment = Record<string, unknown>;

/** Seed a team/project/task and stub the comments fetch with the given list. */
async function setup(
	seeded: Seeded,
	buildComments: (ctx: { task: { id: string }; agent: { id: string; slug: string } }) => Comment[],
) {
	return renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const captain = ws.agents.find((a) => a.slug === 'captain') ?? ws.agents[0];
			const project = await seedProject(ws, { name: 'Run Failed Project' });
			const task = await seedTask(ws, project, {
				title: 'Run Failed Task',
				assignee_id: captain.id,
			});

			seeded.teamId = ws.team.id;
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.agentId = captain.id;
			seeded.agentSlug = captain.slug;

			const comments = buildComments({ task, agent: captain });

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
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});
}

function runFailedComment(taskRowId: string, agentSlug: string, agentId: string): Comment {
	return {
		id: 'aaaa0000-0000-0000-0000-000000000001',
		task_id: taskRowId,
		content_type: 'system',
		content: {
			kind: 'run_failed',
			run_id: FAILED_RUN_ID,
			status: 'timed_out',
			error: 'The operation timed out.',
			member_id: agentId,
			agent_slug: agentSlug,
		},
		chosen_option: null,
		created_at: '2026-05-20T11:30:40Z',
		author_type: 'admin',
		author_name: 'Admin',
		author_member_id: null,
	};
}

test('run_failed comment shows the failure and agent link, without a Retry button', async () => {
	// The Retry affordance lives on the run-entry comment now (always present,
	// even once this alert ping is suppressed after repeated failures), so the
	// run_failed ping itself is display-only — see run-comment-retry.test.tsx.
	const seeded: Seeded = { teamId: '', projectSlug: '', taskId: '', agentId: '', agentSlug: '' };

	const { findByTestId, queryByTestId, router } = await setup(seeded, ({ task, agent }) => [
		runFailedComment(task.id, agent.slug, agent.id),
	]);

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const failureComment = await findByTestId('run-failed-comment', undefined, { timeout: 20_000 });
	expect(failureComment.textContent ?? '').toContain('timed out');
	expect(failureComment.textContent ?? '').toContain('The operation timed out.');

	const agentLink = (await findByTestId('run-failed-agent')) as HTMLAnchorElement;
	expect(agentLink.textContent ?? '').toContain(`@${seeded.agentSlug}`);
	expect(agentLink.getAttribute('href')).toMatch(
		new RegExp(`/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}$`),
	);

	expect(queryByTestId('retry-failed-run')).toBeNull();
});
