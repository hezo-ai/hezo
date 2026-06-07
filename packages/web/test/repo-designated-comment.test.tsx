import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('task page renders repo_designated system comment with a GitHub link', async () => {
	const seeded = { projectSlug: '', taskId: '' };

	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Repo Link Project' });
			const task = await seedTask(ws, project, { title: 'Repo Link Task' });

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();

			const designatedComment = {
				id: 'cccc0000-0000-0000-0000-000000000001',
				task_id: task.id,
				content_type: 'system',
				content: {
					kind: 'repo_designated',
					repo_identifier: 'hiddentao-agent/todos',
					host_type: 'github',
					text: 'Repository hiddentao-agent/todos set as the designated repo.',
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
					return new Response(JSON.stringify({ data: [designatedComment] }), {
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

	const comment = await findByTestId('repo-designated-comment', undefined, { timeout: 20_000 });
	expect(comment.textContent ?? '').toContain('set as the designated repo');

	const link = (await findByTestId('repo-designated-link')) as HTMLAnchorElement;
	expect(link.textContent ?? '').toContain('hiddentao-agent/todos');
	expect(link.getAttribute('href')).toBe('https://github.com/hiddentao-agent/todos');
	expect(link.getAttribute('target')).toBe('_blank');
});
