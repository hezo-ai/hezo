import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

test("a comment's timestamp is a permalink to that comment", async () => {
	const seeded = { projectSlug: '', taskId: '', publicId: '' };
	const { findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Permalink Project' });
			const task = await seedTask(ws, project, { title: 'Permalink Task' });
			const comment = await seedComment(ws, task, 'A comment to link to');
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.publicId = comment.public_id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// The timestamp renders as an anchor whose href is the comment's `#comment-`
	// hash, so a right-click → "Copy link" yields the comment's permalink.
	const link = (await findByTestId('comment-timestamp-link', undefined, {
		timeout: 10_000,
	})) as HTMLAnchorElement;
	expect(link.tagName).toBe('A');
	expect(link.getAttribute('href')).toBe(`#comment-${seeded.publicId}`);
});
