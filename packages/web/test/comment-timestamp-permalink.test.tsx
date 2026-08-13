import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';
import { expandEventGroups } from './helpers/thread';

test("a text comment's timestamp is a permalink to that comment", async () => {
	const seeded = { projectSlug: '', taskId: '', publicId: '' };
	const { findAllByTestId, router } = await renderApp({
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
	const links = (await findAllByTestId('comment-timestamp-link', undefined, {
		timeout: 10_000,
	})) as HTMLAnchorElement[];
	const link = links.find((a) => a.getAttribute('href') === `#comment-${seeded.publicId}`);
	expect(link).toBeDefined();
	expect(link?.tagName).toBe('A');
});

test("an inline event row's timestamp is a permalink to that event", async () => {
	const seeded = { projectSlug: '', taskId: '', publicId: '' };
	const { findAllByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Event Permalink Project' });
			const task = await seedTask(ws, project, { title: 'Event Permalink Task' });
			// Inline system events (status changes, links, run summaries) render their
			// timestamp inside the renderer, not the parent comment row. Insert one
			// directly to assert it now carries the same self-permalink anchor as text
			// comments — the run renderer shares the identical `CommentTimestampLink`.
			const inserted = await ctx.db.query<{ public_id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, $2, 'system'::comment_content_type, $3::jsonb)
				 RETURNING public_id`,
				[
					task.id,
					ws.agents[0].id,
					JSON.stringify({ kind: 'status_change', from: 'backlog', to: 'in_progress' }),
				],
			);
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.publicId = inserted.rows[0].public_id;
		},
	});
	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});

	// The status-change row folds in the default Conversation view; the permalink
	// on it is what this test is about.
	expect(await expandEventGroups(user)).toBeGreaterThan(0);

	const links = (await findAllByTestId('comment-timestamp-link', undefined, {
		timeout: 10_000,
	})) as HTMLAnchorElement[];
	const link = links.find((a) => a.getAttribute('href') === `#comment-${seeded.publicId}`);
	expect(link).toBeDefined();
	expect(link?.tagName).toBe('A');
});
