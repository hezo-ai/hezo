import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

/**
 * The comments feed loads a lightweight skeleton up front and fetches text bodies
 * on demand (batched by id). These assert that split end to end in the component
 * tier: the initial list request is the skeleton, and a text body arrives via a
 * `?ids=` batch — while a meta (system) row renders straight from the skeleton
 * with no body request of its own.
 */
test('loads the skeleton up front and text bodies via a batched ?ids= request', async () => {
	const seeded = { projectSlug: '', taskId: '', textId: '', systemId: '' };

	const fetched: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (url.includes('/comments')) fetched.push(url);
		return original(input, init);
	}, original);

	try {
		const { findByText, router } = await renderApp({
			initialPath: '/',
			seed: async () => {
				const ws = await seedWorkspace();
				const project = await seedProject(ws, { name: 'Lazy Feed' });
				const task = await seedTask(ws, project, { title: 'Lazy Feed Task' });
				const text = await seedComment(ws, task, 'Lazy body loads on view');
				const { db } = getTestContext();
				const sys = await db.query<{ id: string }>(
					`INSERT INTO task_comments (task_id, content_type, content)
					 VALUES ($1, 'system'::comment_content_type, $2::jsonb) RETURNING id`,
					[task.id, JSON.stringify({ text: 'system status note' })],
				);
				seeded.projectSlug = project.slug;
				seeded.taskId = task.identifier.toLowerCase();
				seeded.textId = text.id;
				seeded.systemId = sys.rows[0].id;
			},
		});
		await router.navigate({
			to: '/projects/$projectId/tasks/$taskId',
			params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
		});

		// The text body only appears once its lazy body load resolves.
		await findByText('Lazy body loads on view');
		// The meta row renders straight from the skeleton.
		await findByText('system status note');

		// The feed's list request is the skeleton, never the eager full endpoint.
		const listReqs = fetched.filter((u) => /\/comments(\?|$)/.test(u) && !u.includes('ids='));
		expect(listReqs.some((u) => u.includes('view=skeleton'))).toBe(true);

		// The text body came via a batched ?ids= request that names the text comment
		// but not the system comment (meta rows never fetch a body).
		const bodyReqs = fetched.filter((u) => u.includes('ids='));
		expect(bodyReqs.length).toBeGreaterThan(0);
		expect(bodyReqs.some((u) => u.includes(seeded.textId))).toBe(true);
		expect(bodyReqs.some((u) => u.includes(seeded.systemId))).toBe(false);
	} finally {
		globalThis.fetch = original;
	}
});
