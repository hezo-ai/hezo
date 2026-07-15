import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededTask,
	type SeededWorkspace,
	seedProject,
	seedTask,
	seedWorkspace,
} from './helpers/seed';

/**
 * Seed an agent-authored `@admin` comment on a task plus the resulting unread
 * `admin_mentions` row for the team's admin user (the logged-in session). Mirrors
 * the local helper in inbox-mentions.test.tsx — the mention is authored by an
 * agent, so the admin (recipient) is not excluded as the author.
 */
async function seedAgentAdminMention(
	workspace: SeededWorkspace,
	task: SeededTask,
	text: string,
): Promise<{ commentId: string; mentionId: string; userId: string }> {
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

	return { commentId, mentionId: mentionRow.rows[0].id, userId };
}

async function readAtFor(mentionId: string): Promise<string | null> {
	const { db } = getTestContext();
	const res = await db.query<{ read_at: string | null }>(
		`SELECT read_at FROM admin_mentions WHERE id = $1`,
		[mentionId],
	);
	return res.rows[0]?.read_at ?? null;
}

test('viewing a task comment marks its pending inbox notification read', async () => {
	let ctx: { projectSlug: string; taskIdentifier: string; mentionId: string };
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project: SeededProject = await seedProject(ws, { name: 'Demo' });
			const task = await seedTask(ws, project, { title: 'Needs the admin' });
			const { mentionId } = await seedAgentAdminMention(ws, task, '@admin please confirm.');
			ctx = { projectSlug: project.slug, taskIdentifier: task.identifier, mentionId };
		},
	});

	// Precondition: the notification is unread before the admin looks at the task.
	expect(await readAtFor(ctx!.mentionId)).toBeNull();

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ctx!.projectSlug, taskId: ctx!.taskIdentifier.toLowerCase() },
	});

	// Seeing the comment in the thread marks the notification read (no inbox click).
	await waitFor(
		async () => {
			expect(await readAtFor(ctx!.mentionId)).not.toBeNull();
		},
		{ timeout: 10_000 },
	);
});

test('viewing one task does not mark another task’s pending notification read', async () => {
	let ctx: {
		projectSlug: string;
		viewedIdentifier: string;
		viewedMentionId: string;
		otherMentionId: string;
	};
	const { router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project: SeededProject = await seedProject(ws, { name: 'Demo' });
			const viewed = await seedTask(ws, project, { title: 'Viewed task' });
			const other = await seedTask(ws, project, { title: 'Untouched task' });
			const { mentionId: viewedMentionId } = await seedAgentAdminMention(
				ws,
				viewed,
				'@admin decision needed here.',
			);
			const { mentionId: otherMentionId } = await seedAgentAdminMention(
				ws,
				other,
				'@admin decision needed elsewhere.',
			);
			ctx = {
				projectSlug: project.slug,
				viewedIdentifier: viewed.identifier,
				viewedMentionId,
				otherMentionId,
			};
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: ctx!.projectSlug, taskId: ctx!.viewedIdentifier.toLowerCase() },
	});

	await waitFor(
		async () => {
			expect(await readAtFor(ctx!.viewedMentionId)).not.toBeNull();
		},
		{ timeout: 10_000 },
	);

	// The other task's notification — its comment was never rendered — stays unread.
	expect(await readAtFor(ctx!.otherMentionId)).toBeNull();
});
