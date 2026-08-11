import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededTask,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

async function seedAgentAdminMention(
	workspace: SeededWorkspace,
	task: SeededTask,
	text: string,
): Promise<{ commentId: string; mentionId: string }> {
	const { db } = getTestContext();
	const architect = workspace.agents.find((a) => a.slug === 'architect');
	if (!architect) throw new Error('seedAgentAdminMention: architect agent missing');

	const userRow = await db.query<{ user_id: string }>(
		`SELECT mu.user_id FROM member_users mu
		 JOIN members m ON m.id = mu.id
		 WHERE m.team_id = $1 AND mu.role = 'admin'
		 LIMIT 1`,
		[workspace.team.id],
	);
	const userId = userRow.rows[0]?.user_id;
	if (!userId) throw new Error('seedAgentAdminMention: no admin on team');

	const commentRow = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)
		 RETURNING id`,
		[task.id, architect.id, JSON.stringify({ text })],
	);
	const commentId = commentRow.rows[0].id;

	const mentionRow = await db.query<{ id: string }>(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id`,
		[workspace.team.id, task.id, commentId, userId],
	);

	return { commentId, mentionId: mentionRow.rows[0].id };
}

test('global inbox route mounts across all of the user teams', async () => {
	const { findByRole } = await renderApp({
		initialPath: '/home/inbox',
		seed: async () => {
			await seedWorkspace();
			await seedWorkspace();
		},
	});
	// The /home/inbox route mounts InboxView in global scope (aggregating every
	// team the user belongs to). The page heading distinguishes it from the
	// sidebar's per-team "Inbox" link.
	await findByRole('heading', { name: 'Global inbox' });
});

test('global inbox lists mentions from any team and matches the header badge', async () => {
	const { findByTestId, findAllByTestId } = await renderApp({
		initialPath: '/home/inbox',
		seed: async () => {
			// Team A: no mentions — its slug should not be confused with project slugs.
			await seedWorkspace();
			// Team B: one unread admin mention sitting on a real task.
			const wsB = await seedWorkspace();
			const project = await seedProject(wsB, { name: 'Demo' });
			const task = await seedTask(wsB, project, { title: 'A admin-decision task' });
			await seedAgentAdminMention(wsB, task, '@admin — please weigh in on shipping the new flow.');
		},
	});

	// The list renders the mention card seeded into Team B.
	await waitFor(async () => expect((await findAllByTestId('mention-card')).length).toBe(1), {
		timeout: 10_000,
	});

	// The header badge agrees with the list — same unread count, same source.
	const badge = await findByTestId('app-header-inbox-badge', undefined, { timeout: 10_000 });
	await waitFor(() => expect(badge.textContent).toContain('1'));
});
