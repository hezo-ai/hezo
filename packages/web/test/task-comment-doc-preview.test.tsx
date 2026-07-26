import { expect, test } from 'vitest';
import { clickUntil, renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// A document mention inside a task comment opens in the in-page preview panel
// (with the "open in new tab" affordance moved onto the panel) instead of a new
// tab — and the mention drops its trailing external-link icon.
test('doc mention in a task comment opens the preview panel, not a new tab', async () => {
	const ref = { projectSlug: '', taskId: '' };
	const { container, findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Preview Project' });
			const content = ['# Product Requirements', '', 'An unmistakable document body.'].join('\n');
			const res = await apiBase(`/api/projects/${project.slug}/docs/prd.md`, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ content }),
			});
			if (!res.ok) throw new Error(`seed prd.md failed: ${res.status}`);
			const task = await seedTask(ws, project, { title: 'Review the spec' });
			await seedComment(ws, task, 'Please review prd.md before we ship.');
			ref.projectSlug = project.slug;
			ref.taskId = task.identifier.toLowerCase();
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ref.projectSlug, taskId: ref.taskId },
	});

	// The mention resolves and renders as a button (opens the panel), with no
	// new-tab icon beside it and no panel open yet.
	const mention = await findByTestId('doc-mention-link', undefined, { timeout: 15_000 });
	expect(mention.tagName).toBe('BUTTON');
	expect(container.querySelector('[data-testid="doc-mention-preview-link"]')).toBeNull();
	expect(container.querySelector('[data-testid="preview-panel"]')).toBeNull();

	await clickUntil(
		user,
		() => document.querySelector('[data-testid="doc-mention-link"]'),
		() => !!document.querySelector('[data-testid="preview-panel"]'),
		{ label: 'the doc mention' },
	);

	// The panel opens with the document, its rendered body, and an icon-only
	// open-in-new-tab link sitting immediately before the close button.
	await findByTestId('preview-panel');
	expect((await findByTestId('preview-panel-filename')).textContent).toBe('prd.md');
	await findByText(/unmistakable document body/i);
	const openTab = (await findByTestId('preview-open-tab')) as HTMLAnchorElement;
	expect(openTab.getAttribute('target')).toBe('_blank');
	expect(openTab.getAttribute('href')).toContain('/preview/');
	expect(openTab.getAttribute('aria-label')).toBe('Open in new tab');
	expect(openTab.textContent).toBe('');
	const close = await findByTestId('preview-close');
	expect(openTab.nextElementSibling).toBe(close);
});
