import {
	ADMIN_MENTION_SLUG,
	CommentContentType,
	DEFAULT_TEAM_ID,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastCommentFamilyChange, broadcastRowChange } from '../lib/broadcast';
import { extractMentionSlugs } from '../lib/mentions';
import { logger } from '../logger';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('comment-wakeups');

/**
 * The teammate slugs a mention check on `teamId` may name: every agent in that
 * team plus the HQ instance agents (CEO/Coach), which act inside every team's
 * projects (mirroring the mention-wakeup scoping), excluding `selfMemberId` so a
 * self-reference never counts, plus @admin. Shared by the create_comment
 * unlinked/passive-mention warnings and the runner's handoff-delivery net.
 */
export async function resolveWarnableSlugs(
	db: Db,
	teamId: string,
	selfMemberId: string,
): Promise<string[]> {
	const roster = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE (m.team_id = $1 OR m.team_id = $2) AND ma.id <> $3`,
		[teamId, DEFAULT_TEAM_ID, selfMemberId],
	);
	return [...roster.rows.map((r) => r.slug), ADMIN_MENTION_SLUG];
}

export interface FireCommentWakeupsParams {
	db: Db;
	taskId: string;
	teamId: string;
	commentId: string;
	content: unknown;
	contentType: string;
	authorMemberId: string | null;
	authorUserId?: string | null;
	authorRunId?: string | null;
	effort?: string | null;
	parentCommentId?: string | null;
	wsManager?: WebSocketManager;
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
		authorUserId,
		effort,
		parentCommentId,
		wsManager,
	} = params;

	if (contentType !== CommentContentType.Text) return;

	const effortPayload = effort ? { effort } : {};
	const mentionedAgentIds = new Set<string>();
	const wakeupPromises: Array<Promise<unknown>> = [];

	for (const slug of extractMentionSlugs(content)) {
		if (slug === ADMIN_MENTION_SLUG) {
			await fireAdminMention({
				db,
				teamId,
				taskId,
				commentId,
				authorUserId: authorUserId ?? null,
				wsManager,
			}).catch((e) => log.error('Failed to fan out @admin mention:', e));
			continue;
		}
		// Resolve against the task's team plus the HQ instance agents
		// (CEO/Coach), which act inside every team's projects. A same-team
		// agent wins over an HQ namesake. The wakeup carries the task's team,
		// so an instance agent runs scoped to this project — the run-team
		// split realigns it (see agent-runner).
		const mentioned = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.slug = $1
			   AND (m.team_id = $2 OR (m.team_id = $3 AND $2 <> $3))
			 ORDER BY (m.team_id <> $2)
			 LIMIT 1`,
			[slug, teamId, DEFAULT_TEAM_ID],
		);
		if (mentioned.rows.length === 0) continue;
		const mentionedId = mentioned.rows[0].id;
		if (mentionedId === authorMemberId) continue;
		mentionedAgentIds.add(mentionedId);
		const idempotencyKey = `mention:${taskId}:${mentionedId}:${authorMemberId ?? 'admin'}`;
		wakeupPromises.push(
			createWakeup(
				db,
				mentionedId,
				teamId,
				WakeupSource.Mention,
				{
					source: WakeupSource.Mention,
					task_id: taskId,
					comment_id: commentId,
					...effortPayload,
				},
				idempotencyKey,
			).catch((e) => log.error('Failed to create mention wakeup:', e)),
		);
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

export interface PostAgentCommentParams {
	db: Db;
	wsManager?: WebSocketManager;
	teamId: string;
	projectId: string;
	taskId: string;
	authorMemberId: string | null;
	authorApiKeyId?: string | null;
	authorUserId?: string | null;
	createdByRunId: string | null;
	parentCommentId?: string | null;
	text: string;
	effort?: string | null;
}

/**
 * Insert a text comment on a task and run the exact delivery side effects a
 * `create_comment` MCP call does — the realtime broadcast plus
 * `fireCommentWakeups` (mention / @admin inbox / reply fan-out). Shared by the
 * `create_comment` tool and the runner's handoff-delivery guardrail so an
 * auto-delivered final message is byte-identical to a comment the agent posts
 * itself. Returns the inserted row (`RETURNING *`, so it carries `public_id`).
 */
export async function postAgentComment(
	params: PostAgentCommentParams,
): Promise<{ id: string; public_id: string } & Record<string, unknown>> {
	const {
		db,
		wsManager,
		teamId,
		projectId,
		taskId,
		authorMemberId,
		authorApiKeyId = null,
		authorUserId = null,
		createdByRunId,
		parentCommentId = null,
		text,
		effort,
	} = params;

	const content = { text };
	const r = await db.query<{ id: string; public_id: string } & Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, parent_comment_id, content_type, content, created_by_run_id) VALUES ($1, $2, $3, $4, $5::comment_content_type, $6::jsonb, $7) RETURNING *`,
		[
			taskId,
			authorMemberId,
			authorApiKeyId,
			parentCommentId,
			CommentContentType.Text,
			JSON.stringify(content),
			createdByRunId,
		],
	);
	const row = r.rows[0];
	// Realtime: notify open task pages. task_comments has no project_id column, so
	// the helper injects it for the web client's slug resolution.
	broadcastCommentFamilyChange(wsManager, teamId, projectId, 'task_comments', 'INSERT', row);
	await fireCommentWakeups({
		db,
		taskId,
		teamId,
		commentId: row.id,
		content,
		contentType: CommentContentType.Text,
		authorMemberId,
		authorUserId,
		authorRunId: createdByRunId,
		effort,
		parentCommentId,
		wsManager,
	});
	return row;
}

interface ReplyWakeupCtx {
	db: Db;
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

export interface FireAdminMentionParams {
	db: Db;
	teamId: string;
	taskId: string;
	commentId: string;
	authorUserId: string | null;
	wsManager?: WebSocketManager;
}

/**
 * Fan an actionable comment out to the humans who can act on it: unread
 * `admin_mentions` rows for the team's admin users ∪ all superusers (deduped),
 * raising the inbox badge. Exported for flows that must reach an admin without
 * literal `@admin` text in a comment body (e.g. asset-deletion requests).
 */
export async function fireAdminMention(params: FireAdminMentionParams): Promise<void> {
	const { db, teamId, taskId, commentId, authorUserId, wsManager } = params;

	// Recipients: the team's admin member_users ∪ all superusers. Teams created
	// by the CEO's create_project have no human members at all, so without the
	// superuser leg an @admin ask on them would fan out to nobody and vanish
	// silently. UNION dedupes a superuser who is also a team admin.
	const adminUsers = await db.query<{ user_id: string }>(
		`SELECT mu.user_id FROM member_users mu
		 JOIN members m ON m.id = mu.id
		 WHERE m.team_id = $1 AND mu.role = 'admin'
		 UNION
		 SELECT id AS user_id FROM users WHERE is_superuser = true`,
		[teamId],
	);
	if (adminUsers.rows.length === 0) return;

	const recipients = adminUsers.rows.map((r) => r.user_id).filter((uid) => uid !== authorUserId);
	if (recipients.length === 0) return;

	const inserted = await db.query<{
		id: string;
		team_id: string;
		task_id: string;
		comment_id: string;
		user_id: string;
		created_at: string;
		read_at: string | null;
	}>(
		`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
		 SELECT $1::uuid, $2::uuid, $3::uuid, uid
		 FROM UNNEST($4::uuid[]) AS uid
		 ON CONFLICT (comment_id, user_id) DO NOTHING
		 RETURNING *`,
		[teamId, taskId, commentId, recipients],
	);

	if (!wsManager) return;
	for (const row of inserted.rows) {
		broadcastRowChange(
			wsManager,
			wsRoom.team(teamId),
			'admin_mentions',
			'INSERT',
			row as unknown as Record<string, unknown>,
		);
	}
}
