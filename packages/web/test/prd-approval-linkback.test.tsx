import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// Guards the codified PRD metadata format from product-lead.md: once the admin
// approves, the Product Lead rewrites prd.md's header with
// `Approved in <TASK-ID>#comment-<public_id>`. This asserts that header renders in
// the documents viewer as a clickable deep link to the approval comment.
// Render-driven (no real layout/WebSocket), so it belongs in the component tier.
test('approved PRD metadata links back to the approval task + comment', async () => {
	const seeded = { projectSlug: '', taskId: '', commentId: '' };

	const { findByTestId, findByText, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'PRD Linkback Project' });
			const task = await seedTask(ws, project, { title: 'Draft the PRD' });
			const approval = await seedComment(ws, task, 'Approved — ship it.');

			// The approved header the Product Lead stamps at step 7.
			const content = [
				'# Product Requirements Document: Demo',
				'',
				'Status: Approved',
				'Author: @@product-lead',
				'Input: research.md by @@researcher',
				'Date: 2026-06-11',
				`Approved in ${task.identifier}#comment-${approval.public_id}`,
			].join('\n');

			const res = await apiBase(`/api/projects/${project.slug}/docs/prd.md`, {
				method: 'PUT',
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ content }),
			});
			if (!res.ok) throw new Error(`seed prd.md failed: ${res.status}`);

			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.commentId = approval.public_id;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: seeded.projectSlug },
		search: { file: 'prd.md' } as never,
	});

	// Doc body rendered.
	await findByText(/Product Requirements Document/, undefined, { timeout: 15_000 });

	// findByTestId auto-waits for the useTaskMentions resolve to land and re-render.
	const link = (await findByTestId('comment-mention-link')) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/tasks/${seeded.taskId}#comment-${seeded.commentId}`,
	);
});
