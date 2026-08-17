import { expect, test } from 'vitest';
import { clickUntil, renderApp } from './helpers/render';
import { seedComment, seedDocument, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// The task-detail route serves every task on `/projects/$projectId/tasks/$taskId`
// from ONE component instance, so its per-visit `useState` used to survive a
// task→task navigation and leak into the next task. These cover the two leaks
// that reach the user: a document left pinned in the preview panel, and a reply
// target that would parent the next comment to a comment on another task.

test('the doc preview panel does not follow the reader into another task', async () => {
	const ref = { projectSlug: '', firstTask: '', secondTask: '' };
	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Preview Project' });
			await seedDocument(ws, project, {
				filename: 'prd.md',
				content: ['# Product Requirements', '', 'An unmistakable document body.'].join('\n'),
			});
			const first = await seedTask(ws, project, { title: 'Review the spec' });
			await seedComment(ws, first, 'Please review prd.md before we ship.');
			// The task the reader creates next. Deliberately has no doc mention of
			// its own, so anything in the panel came from the task before it.
			const second = await seedTask(ws, project, { title: 'Remove non-portfolio stocks' });
			ref.projectSlug = project.slug;
			ref.firstTask = first.identifier.toLowerCase();
			ref.secondTask = second.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ref.projectSlug, taskId: ref.firstTask },
	});

	await clickUntil(
		user,
		() => document.querySelector('[data-testid="doc-mention-link"]'),
		() => !!document.querySelector('[data-testid="preview-panel"]'),
		{ label: 'the doc mention' },
	);
	expect((await findByTestId('preview-panel-filename')).textContent).toBe('prd.md');

	// Same route, different params — the navigation a freshly created task makes.
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ref.projectSlug, taskId: ref.secondTask },
	});

	await findByText('Remove non-portfolio stocks');
	expect(document.querySelector('[data-testid="preview-panel"]')).toBeNull();
});

test('a reply target does not follow the reader into another task', async () => {
	const ref = { projectSlug: '', firstTask: '', secondTask: '' };
	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Reply Project' });
			const first = await seedTask(ws, project, { title: 'Review the spec' });
			await seedComment(ws, first, 'A comment worth replying to.');
			const second = await seedTask(ws, project, { title: 'Remove non-portfolio stocks' });
			ref.projectSlug = project.slug;
			ref.firstTask = first.identifier.toLowerCase();
			ref.secondTask = second.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ref.projectSlug, taskId: ref.firstTask },
	});

	await clickUntil(
		user,
		() => document.querySelector('[data-testid="comment-reply"]'),
		() => !!document.querySelector('[data-testid="reply-indicator"]'),
		{ label: 'the comment reply button' },
	);
	await findByTestId('reply-indicator');

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ref.projectSlug, taskId: ref.secondTask },
	});

	// A surviving target would post the next comment with a `parent_comment_id`
	// pointing at a comment on the task the reader just left.
	await findByText('Remove non-portfolio stocks');
	expect(document.querySelector('[data-testid="reply-indicator"]')).toBeNull();
});
