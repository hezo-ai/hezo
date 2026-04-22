import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, WakeupSource } from '@hezo/shared';
import { extractMentionSlugs } from '../lib/mentions';
import { logger } from '../logger';
import { createWakeup } from './wakeup';

const log = logger.child('comment-wakeups');

export interface FireCommentWakeupsParams {
	db: PGlite;
	issueId: string;
	companyId: string;
	commentId: string;
	content: unknown;
	contentType: string;
	authorMemberId: string | null;
	authorRunId?: string | null;
	effort?: string | null;
	wakeAssignee?: boolean;
}

export async function fireCommentWakeups(params: FireCommentWakeupsParams): Promise<void> {
	const {
		db,
		issueId,
		companyId,
		commentId,
		content,
		contentType,
		authorMemberId,
		authorRunId,
		effort,
		wakeAssignee,
	} = params;

	if (contentType !== CommentContentType.Text) return;

	const effortPayload = effort ? { effort } : {};
	const mentionedAgentIds = new Set<string>();
	const wakeupPromises: Array<Promise<unknown>> = [];

	for (const slug of extractMentionSlugs(content)) {
		const mentioned = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.slug = $1 AND m.company_id = $2`,
			[slug, companyId],
		);
		if (mentioned.rows.length === 0) continue;
		const mentionedId = mentioned.rows[0].id;
		if (mentionedId === authorMemberId) continue;
		mentionedAgentIds.add(mentionedId);
		wakeupPromises.push(
			createWakeup(db, mentionedId, companyId, WakeupSource.Mention, {
				source: WakeupSource.Mention,
				issue_id: issueId,
				comment_id: commentId,
				...effortPayload,
			}).catch((e) => log.error('Failed to create mention wakeup:', e)),
		);
	}

	if (wakeAssignee) {
		const issueRow = await db.query<{ assignee_id: string | null }>(
			'SELECT assignee_id FROM issues WHERE id = $1 AND company_id = $2',
			[issueId, companyId],
		);
		const assigneeId = issueRow.rows[0]?.assignee_id ?? null;
		if (assigneeId && assigneeId !== authorMemberId && !mentionedAgentIds.has(assigneeId)) {
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
			if (isAgent.rows.length > 0) {
				wakeupPromises.push(
					createWakeup(db, assigneeId, companyId, WakeupSource.Comment, {
						issue_id: issueId,
						comment_id: commentId,
						...effortPayload,
					}).catch((e) => log.error('Failed to create comment wakeup:', e)),
				);
			}
		}
	}

	await Promise.all(wakeupPromises);

	if (authorMemberId && authorRunId) {
		await fireReplyWakeupIfApplicable({
			db,
			issueId,
			companyId,
			commentId,
			authorMemberId,
			authorRunId,
			alreadyWokenAgentIds: mentionedAgentIds,
			effortPayload,
		});
	}
}

interface ReplyWakeupCtx {
	db: PGlite;
	issueId: string;
	companyId: string;
	commentId: string;
	authorMemberId: string;
	authorRunId: string;
	alreadyWokenAgentIds: Set<string>;
	effortPayload: Record<string, unknown>;
}

async function fireReplyWakeupIfApplicable(ctx: ReplyWakeupCtx): Promise<void> {
	const {
		db,
		issueId,
		companyId,
		commentId,
		authorMemberId,
		authorRunId,
		alreadyWokenAgentIds,
		effortPayload,
	} = ctx;

	const runWakeup = await db.query<{ source: string; payload: Record<string, unknown> }>(
		`SELECT w.source::text AS source, w.payload
		 FROM heartbeat_runs r
		 JOIN agent_wakeup_requests w ON w.id = r.wakeup_id
		 WHERE r.id = $1 AND r.company_id = $2`,
		[authorRunId, companyId],
	);
	if (runWakeup.rows.length === 0) return;
	if (runWakeup.rows[0].source !== WakeupSource.Mention) return;

	const triggeringCommentId =
		typeof runWakeup.rows[0].payload.comment_id === 'string'
			? runWakeup.rows[0].payload.comment_id
			: null;
	const triggeringIssueId =
		typeof runWakeup.rows[0].payload.issue_id === 'string'
			? runWakeup.rows[0].payload.issue_id
			: null;
	if (!triggeringCommentId || triggeringIssueId !== issueId) return;

	const settings = await db.query<{ wake: boolean | null }>(
		`SELECT COALESCE((settings->>'wake_mentioner_on_reply')::boolean, true) AS wake
		 FROM companies WHERE id = $1`,
		[companyId],
	);
	if (settings.rows.length === 0 || settings.rows[0].wake === false) return;

	const triggeringComment = await db.query<{ author_member_id: string | null }>(
		'SELECT author_member_id FROM issue_comments WHERE id = $1',
		[triggeringCommentId],
	);
	const originalAuthorId = triggeringComment.rows[0]?.author_member_id ?? null;
	if (!originalAuthorId) return;
	if (originalAuthorId === authorMemberId) return;
	if (alreadyWokenAgentIds.has(originalAuthorId)) return;

	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [originalAuthorId]);
	if (isAgent.rows.length === 0) return;

	const idempotencyKey = `reply:${triggeringCommentId}:${commentId}`;
	try {
		await createWakeup(
			db,
			originalAuthorId,
			companyId,
			WakeupSource.Reply,
			{
				source: WakeupSource.Reply,
				issue_id: issueId,
				comment_id: commentId,
				triggering_comment_id: triggeringCommentId,
				responder_member_id: authorMemberId,
				...effortPayload,
			},
			idempotencyKey,
		);
	} catch (e) {
		log.error('Failed to create reply wakeup:', e);
	}
}
