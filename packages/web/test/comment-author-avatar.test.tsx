import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

// The reported bug: an admin uploads an avatar on Settings → Users, but their
// comments still show the "AD" initials. Verifies the fix end-to-end — a comment
// authored by a user who has an uploaded avatar renders that avatar as an <img>
// in the task activity feed, not the initials fallback.
test("renders the admin's uploaded avatar on their comment", async () => {
	let nav!: { projectSlug: string; taskId: string };
	let adminUserId!: string;
	const { findByText, container, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Avatar Demo' });
			const task = await seedTask(ws, project, { title: 'Avatar Task' });

			// Give the admin (the board token's user) an uploaded avatar.
			const admin = await ctx.db.query<{ id: string }>(
				`SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1`,
			);
			adminUserId = admin.rows[0].id;
			await ctx.db.query(
				`INSERT INTO user_icons (user_id, content_type, data, byte_size, width, height)
				 VALUES ($1, 'image/png', $2, 3, 512, 512)`,
				[adminUserId, Buffer.from([0x89, 0x50, 0x4e])],
			);

			// Authored via the board token, so author_user_id = the admin.
			await seedComment(ws, task, 'from the admin with an avatar');
			nav = { projectSlug: project.slug, taskId: task.identifier.toLowerCase() };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: nav.projectSlug, taskId: nav.taskId },
	});

	await findByText('from the admin with an avatar');

	const avatar = container.querySelector<HTMLImageElement>('[data-testid="comment-item"] img');
	expect(avatar).not.toBeNull();
	expect(avatar?.getAttribute('src') ?? '').toContain(`/api/users/${adminUserId}/icon`);
});
