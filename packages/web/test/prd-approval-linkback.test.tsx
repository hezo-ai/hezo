import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// Guards the codified PRD approval flow from product-lead.md: once the admin
// approves, the Product Lead records `Approved in <TASK-ID>#comment-<public_id>`
// in the write's CHANGELOG (no longer in the document body). This asserts that
// changelog renders in the revision-history dialog as a clickable deep link to
// the approval comment. Render-driven (no real layout/WebSocket), component tier.
test('the approval changelog links back to the approval task + comment', async () => {
	const seeded = { projectSlug: '', taskId: '', commentId: '' };

	const { findByTestId, findByText, user, router } = await renderApp({
		initialPath: '/',
		seed: async ({ apiBase, token }) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'PRD Linkback Project' });
			const task = await seedTask(ws, project, { title: 'Draft the PRD' });
			const approval = await seedComment(ws, task, 'Approved — ship it.');

			const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
			const docPath = `/api/projects/${project.slug}/docs/prd.md`;
			// Draft, then the approval write that records the linkback in its changelog.
			const draft = await apiBase(docPath, {
				method: 'PUT',
				headers,
				body: JSON.stringify({ content: '# Product Requirements Document: Demo\n\nDraft body.' }),
			});
			if (!draft.ok) throw new Error(`seed draft failed: ${draft.status}`);
			const approved = await apiBase(docPath, {
				method: 'PUT',
				headers,
				body: JSON.stringify({
					content: '# Product Requirements Document: Demo\n\nApproved body.',
					change_summary: `Approved in ${task.identifier}#comment-${approval.public_id}`,
				}),
			});
			if (!approved.ok) throw new Error(`seed approval failed: ${approved.status}`);

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

	await findByText(/Product Requirements Document/, undefined, { timeout: 15_000 });

	// Open the revision-history dialog — the approval changelog renders like a comment.
	await user.click(await findByTestId('doc-history'));
	await findByTestId('revision-history-dialog', undefined, { timeout: 15_000 });

	// findByTestId auto-waits for the useTaskMentions resolve to land and re-render.
	const link = (await findByTestId('comment-mention-link')) as HTMLAnchorElement;
	expect(link.getAttribute('href')).toBe(
		`/projects/${seeded.projectSlug}/tasks/${seeded.taskId}#comment-${seeded.commentId}`,
	);
});
