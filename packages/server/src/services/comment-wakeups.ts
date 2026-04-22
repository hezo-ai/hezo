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
	effort?: string | null;
}

export async function fireCommentWakeups(params: FireCommentWakeupsParams): Promise<void> {
	const { db, issueId, companyId, commentId, content, contentType, authorMemberId, effort } =
		params;

	// System/Run/Trace/Options/Preview/Action comments are internal channels
	// with no user-authored @mentions.
	if (contentType !== CommentContentType.Text) return;

	const issueRow = await db.query<{ assignee_id: string | null }>(
		'SELECT assignee_id FROM issues WHERE id = $1 AND company_id = $2',
		[issueId, companyId],
	);
	const assigneeId = issueRow.rows[0]?.assignee_id ?? null;

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

	if (assigneeId && !mentionedAgentIds.has(assigneeId) && assigneeId !== authorMemberId) {
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

	await Promise.all(wakeupPromises);
}
