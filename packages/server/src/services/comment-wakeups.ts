import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, WakeupSource } from '@hezo/shared';
import { extractMentionSlugs } from '../lib/mentions';
import { logger } from '../logger';
import { createWakeup } from './wakeup';

const log = logger.child('comment-wakeups');

export interface FireCommentWakeupsParams {
	db: PGlite;
	taskId: string;
	teamId: string;
	commentId: string;
	content: unknown;
	contentType: string;
	authorMemberId: string | null;
	authorRunId?: string | null;
	effort?: string | null;
	wakeAssignee?: boolean;
	parentCommentId?: string | null;
}

export async function fireCommentWakeups(params: FireCommentWakeupsParams): Promise<void> {
	const {
		db,
		taskId,
		teamId,
		commentId,
		content,
		contentType,
		authorMemberId,
		effort,
		wakeAssignee,
		parentCommentId,
	} = params;

	if (contentType !== CommentContentType.Text) return;

	const effortPayload = effort ? { effort } : {};
	const mentionedAgentIds = new Set<string>();
	const wakeupPromises: Array<Promise<unknown>> = [];

	for (const slug of extractMentionSlugs(content)) {
		const mentioned = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.slug = $1 AND m.team_id = $2`,
			[slug, teamId],
		);
		if (mentioned.rows.length === 0) continue;
		const mentionedId = mentioned.rows[0].id;
		if (mentionedId === authorMemberId) continue;
		mentionedAgentIds.add(mentionedId);
		wakeupPromises.push(
			createWakeup(db, mentionedId, teamId, WakeupSource.Mention, {
				source: WakeupSource.Mention,
				task_id: taskId,
				comment_id: commentId,
				...effortPayload,
			}).catch((e) => log.error('Failed to create mention wakeup:', e)),
		);
	}

	if (wakeAssignee) {
		const taskRow = await db.query<{ assignee_id: string | null }>(
			'SELECT assignee_id FROM tasks WHERE id = $1 AND team_id = $2',
			[taskId, teamId],
		);
		const assigneeId = taskRow.rows[0]?.assignee_id ?? null;
		if (assigneeId && assigneeId !== authorMemberId && !mentionedAgentIds.has(assigneeId)) {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
			if (isAgent.rows.length > 0) {
				wakeupPromises.push(
					createWakeup(db, assigneeId, teamId, WakeupSource.Comment, {
						task_id: taskId,
						comment_id: commentId,
						...effortPayload,
					}).catch((e) => log.error('Failed to create comment wakeup:', e)),
				);
			}
		}
	}

	await Promise.all(wakeupPromises);

	if (parentCommentId) {
		await fireExplicitReplyWakeup({
			db,
			taskId,
			teamId,
			commentId,
			authorMemberId,
			parentCommentId,
			alreadyWokenAgentIds: mentionedAgentIds,
			effortPayload,
		});
	}
}

interface ReplyWakeupCtx {
	db: PGlite;
	taskId: string;
	teamId: string;
	commentId: string;
	authorMemberId: string | null;
	parentCommentId: string;
	alreadyWokenAgentIds: Set<string>;
	effortPayload: Record<string, unknown>;
}

async function fireExplicitReplyWakeup(ctx: ReplyWakeupCtx): Promise<void> {
	const {
		db,
		taskId,
		teamId,
		commentId,
		authorMemberId,
		parentCommentId,
		alreadyWokenAgentIds,
		effortPayload,
	} = ctx;

	const settings = await db.query<{ wake: boolean | null }>(
		`SELECT COALESCE((settings->>'wake_mentioner_on_reply')::boolean, true) AS wake
		 FROM teams WHERE id = $1`,
		[teamId],
	);
	if (settings.rows.length === 0 || settings.rows[0].wake === false) return;

	const parent = await db.query<{ author_member_id: string | null }>(
		'SELECT author_member_id FROM task_comments WHERE id = $1',
		[parentCommentId],
	);
	const originalAuthorId = parent.rows[0]?.author_member_id ?? null;
	if (!originalAuthorId) return;
	if (originalAuthorId === authorMemberId) return;
	if (alreadyWokenAgentIds.has(originalAuthorId)) return;

	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [originalAuthorId]);
	if (isAgent.rows.length === 0) return;

	const idempotencyKey = `reply:${parentCommentId}:${commentId}`;
	try {
		await createWakeup(
			db,
			originalAuthorId,
			teamId,
			WakeupSource.Reply,
			{
				source: WakeupSource.Reply,
				task_id: taskId,
				comment_id: commentId,
				triggering_comment_id: parentCommentId,
				responder_member_id: authorMemberId,
				...effortPayload,
			},
			idempotencyKey,
		);
	} catch (e) {
		log.error('Failed to create reply wakeup:', e);
	}
}
