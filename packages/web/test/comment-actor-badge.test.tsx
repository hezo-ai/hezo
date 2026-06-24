import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// Verifies the human-vs-API-key badge wiring end-to-end: a comment authored by an
// API key renders with the bot badge in the task activity feed.
test('flags an API-key-authored comment with a bot badge', async () => {
	let nav!: { projectSlug: string; taskId: string };
	const { findByText, findByTestId, router } = await renderApp({
		initialPath: '/',
		seed: async (ctx) => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Badge Demo' });
			const task = await seedTask(ws, project, { title: 'Badge Task' });
			const ca = await ctx.db.query<{ id: string }>(
				`INSERT INTO api_keys (name, prefix, key_hash, status)
				 VALUES ('Ops Bot', 'aaaaaaaa', 'h1', 'approved') RETURNING id`,
			);
			await ctx.db.query(
				`INSERT INTO task_comments (task_id, author_api_key_id, content_type, content)
				 VALUES ($1, $2, 'text', $3::jsonb)`,
				[task.id, ca.rows[0].id, JSON.stringify({ text: 'handled by the API key' })],
			);
			nav = { projectSlug: project.slug, taskId: task.identifier.toLowerCase() };
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: nav.projectSlug, taskId: nav.taskId },
	});

	await findByText('handled by the API key');
	const badge = await findByTestId('actor-badge-api-key');
	expect(badge.getAttribute('aria-label')).toBe('API key');
});
