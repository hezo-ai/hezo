import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('task page renders run_failed system comment with agent link and error', async () => {
	const seeded = {
		teamId: '',
		projectSlug: '',
		taskId: '',
		agentId: '',
		agentSlug: '',
	};

	const { findByTestId, router } = await renderApp({
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

			const failedComment = {
				id: 'aaaa0000-0000-0000-0000-000000000001',
				task_id: task.id,
				content_type: 'system',
				content: {
					kind: 'run_failed',
					run_id: 'bbbb0000-0000-0000-0000-000000000777',
					status: 'timed_out',
					error: 'The operation timed out.',
					member_id: captain.id,
					agent_slug: captain.slug,
				},
				chosen_option: null,
				created_at: '2026-05-20T11:30:40Z',
				author_type: 'admin',
				author_name: 'Admin',
				author_member_id: null,
			};

			const originalFetch = globalThis.fetch;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : (input as Request).url;
				const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
				if (method === 'GET' && /\/api\/projects\/[^/]+\/tasks\/[^/]+\/comments/.test(url)) {
					return new Response(JSON.stringify({ data: [failedComment] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return originalFetch(input as RequestInfo, init);
			}) as typeof globalThis.fetch;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	const failureComment = await findByTestId('run-failed-comment', undefined, {
		timeout: 20_000,
	});
	expect(failureComment.textContent ?? '').toContain('timed out');
	expect(failureComment.textContent ?? '').toContain('The operation timed out.');
	expect(failureComment.textContent ?? '').toContain('Waking agent to retry.');

	const agentLink = (await findByTestId('run-failed-agent')) as HTMLAnchorElement;
	expect(agentLink.textContent ?? '').toContain(`@${seeded.agentSlug}`);
	expect(agentLink.getAttribute('href')).toMatch(
		new RegExp(`/projects/${seeded.projectSlug}/agents/${seeded.agentSlug}$`),
	);
});
