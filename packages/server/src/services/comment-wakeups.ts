import {
	ADMIN_MENTION_SLUG,
	CommentContentType,
	DEFAULT_TEAM_ID,
	TERMINAL_TASK_STATUSES,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastCommentFamilyChange, broadcastRowChange } from '../lib/broadcast';
import {
	detectUnlinkedTeammateReferences,
	extractMentionSlugs,
	extractPassiveMentionSlugs,
} from '../lib/mentions';
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
	const roster = await db.query<{ slug: string; human_name_slug: string | null }>(
		`SELECT ma.slug, ma.human_name_slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE (m.team_id = $1 OR m.team_id = $2) AND ma.id <> $3`,
		[teamId, DEFAULT_TEAM_ID, selfMemberId],
	);
	// Both handles are real: a teammate can be reached by role or by name, so the
	// detectors that read this roster have to recognise either spelling.
	return [
		...roster.rows.flatMap((r) => (r.human_name_slug ? [r.slug, r.human_name_slug] : [r.slug])),
		ADMIN_MENTION_SLUG,
	];
}

/**
 * What a comment write actually DID, reported rather than inferred.
 *
 * Every heuristic in `lib/mentions.ts` guesses whether an author *meant* to ask
 * someone; this is the complementary fact, and it needs no vocabulary at all: the
 * fan-out reports who it woke, and the passive/bare references report who was
 * named without being woken. An agent that intended an ask sees an empty `woke`
 * and can fix it without any warning having to fire.
 *
 * This is the affordance human authors already have — the composer renders a live
 * "Wake:" preview (packages/web/src/components/task-detail/comment-composer.tsx)
 * — brought to the agent-facing write path.
 */
export interface CommentWakeReceipt {
	/**
	 * Teammate slugs this comment woke. `admin` appears when the @admin inbox
	 * fan-out ran; a reply-target agent appears even with no mention text.
	 */
	woke: string[];
	/**
	 * Roster teammates the comment NAMES without waking them — a passive
	 * `@@slug`, or a bare/bold name in an addressing position. Deliberately not
	 * every prose occurrence of a slug: a factual receipt must not claim the
	 * author "named" someone because a role word appeared in a sentence.
	 */
	named_not_woken: string[];
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

/**
 * Fan a comment out to everyone it addresses, and report who that was. The
 * returned slug list is built by the fan-out itself — recorded at the exact
 * points a wakeup is created — so a receipt can never drift from the delivery it
 * describes.
 */
export async function fireCommentWakeups(params: FireCommentWakeupsParams): Promise<string[]> {
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

	if (contentType !== CommentContentType.Text) return [];

	const effortPayload = effort ? { effort } : {};
	const mentionedAgentIds = new Set<string>();
	const wakeupPromises: Array<Promise<unknown>> = [];
	// Recorded where each wakeup is actually created, never re-derived from the
	// text, so the receipt and the delivery cannot disagree.
	const woke: string[] = [];

	for (const slug of extractMentionSlugs(content)) {
		if (slug === ADMIN_MENTION_SLUG) {
			woke.push(ADMIN_MENTION_SLUG);
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
		// A token matches either handle an agent answers to: its role slug or the
		// slug of its human name. Same-team still beats an HQ namesake, and within
		// a team the role slug wins over someone else's name - the set-time
		// uniqueness check stops that pair ever being created, so the tiebreak only
		// ever settles an HQ collision.
		const mentioned = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE (ma.slug = $1 OR ma.human_name_slug = $1)
			   AND (m.team_id = $2 OR (m.team_id = $3 AND $2 <> $3))
			 ORDER BY (m.team_id <> $2), (ma.slug <> $1)
			 LIMIT 1`,
			[slug, teamId, DEFAULT_TEAM_ID],
		);
		if (mentioned.rows.length === 0) continue;
		const mentionedId = mentioned.rows[0].id;
		if (mentionedId === authorMemberId) continue;
		mentionedAgentIds.add(mentionedId);
		woke.push(slug);
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
		const repliedTo = await fireExplicitReplyWakeup({
			db,
			taskId,
			teamId,
			commentId,
			authorMemberId,
			parentCommentId,
			alreadyWokenAgentIds: mentionedAgentIds,
			effortPayload,
		});
		if (repliedTo) woke.push(repliedTo);
	}

	return Array.from(new Set(woke));
}

/**
 * Complete a receipt: pair the slugs the fan-out actually woke with the roster
 * teammates the same text names but does NOT wake. Purely structural — no ask
 * heuristic runs here, so the receipt stays true whatever the prose looks like.
 *
 * Takes the roster rather than resolving it, so a caller that already holds one
 * (every comment-write path does, for the mention advisories) adds no DB round
 * trip to produce the receipt.
 */
export function buildWakeReceipt(
	content: unknown,
	woke: string[],
	roster: string[],
): CommentWakeReceipt {
	const known = new Set(roster.map((s) => s.toLowerCase()));
	const wokeSet = new Set(woke.map((s) => s.toLowerCase()));
	const named = new Set<string>();
	// A passive `@@slug` is an explicit "name them, don't wake them"; a bare/bold
	// name in an addressing position is the same intent written by accident.
	for (const slug of extractPassiveMentionSlugs(content)) {
		if (known.has(slug) && !wokeSet.has(slug)) named.add(slug);
	}
	for (const slug of detectUnlinkedTeammateReferences(content, roster)) {
		if (!wokeSet.has(slug)) named.add(slug);
	}
	return { woke: Array.from(wokeSet), named_not_woken: Array.from(named) };
}

/** One comment considered by {@link detectNoWakeExits}. */
export interface NoWakeExitComment {
	task_id: string;
	content: unknown;
	parent_comment_id: string | null;
}

/** A task an execution left open having notified nobody while naming someone. */
export interface NoWakeExitFinding {
	taskId: string;
	identifier: string;
	/** Roster teammates named in a form that notifies no one. */
	named: string[];
}

/**
 * The structural no-wake exit check, shared by the task runner and the CEO chat.
 *
 * Every other gate in this area classifies TEXT, so each new phrasing that
 * strands a handoff needs new vocabulary. This one asks a question the system can
 * answer from its own state: did an execution end having woken NOBODY on a task
 * it left open, after naming a teammate in a form that notifies no one? That
 * combination is what a stranded handoff IS, whatever words carried it.
 *
 * It is also the only check that looks at what an execution achieved in
 * AGGREGATE - the runner's delivery net inspects only a final message, and
 * `create_comment`'s receipt only one comment at a time, so a passively-addressed
 * ask posted as a comment lives exactly in the gap between them.
 *
 * The aggregate is PER TASK, not per execution: judged execution-wide, a run that
 * woke someone on its own task could strand a handoff on another one and still
 * pass clean. Terminal tasks are skipped - nobody is expected to act next on a
 * closed task.
 *
 * `extraOutward` carries outward-facing text that belongs to a task without being
 * a comment on it (the runner's final message, on the run's own task). Its keys
 * also force those tasks to be judged even with no comment posted, which is how
 * a handoff that never left the final message is caught.
 *
 * Detection only: the caller decides where a finding is reported, and no caller
 * fabricates a wake from it. Use {@link formatNoWakeExitWarning} for the wording.
 */
export async function detectNoWakeExits(
	db: Db,
	input: {
		/** The acting agent, excluded from its own roster so a self-reference never counts. */
		selfMemberId: string;
		comments: readonly NoWakeExitComment[];
		extraOutward?: ReadonlyMap<string, readonly string[]>;
	},
): Promise<NoWakeExitFinding[]> {
	const byTask = new Map<string, NoWakeExitComment[]>();
	for (const row of input.comments) {
		const bucket = byTask.get(row.task_id);
		if (bucket) bucket.push(row);
		else byTask.set(row.task_id, [row]);
	}
	for (const taskId of input.extraOutward?.keys() ?? []) {
		if (!byTask.has(taskId)) byTask.set(taskId, []);
	}
	if (byTask.size === 0) return [];

	// One read for every touched task rather than one per task, and it carries
	// team_id so a cross-team comment is warned against the right roster (an HQ
	// agent acting inside another team's project).
	const touched = await db.query<{
		id: string;
		identifier: string;
		team_id: string;
		status: string;
	}>(
		`SELECT id, identifier, team_id, status::text AS status
		 FROM tasks WHERE id = ANY($1)`,
		[Array.from(byTask.keys())],
	);

	// Memoized per team — one call in the ordinary single-team case.
	const rosterByTeam = new Map<string, string[]>();
	const rosterFor = async (teamId: string): Promise<string[]> => {
		const cached = rosterByTeam.get(teamId);
		if (cached) return cached;
		const resolved = await resolveWarnableSlugs(db, teamId, input.selfMemberId);
		rosterByTeam.set(teamId, resolved);
		return resolved;
	};

	const findings: NoWakeExitFinding[] = [];
	for (const row of touched.rows) {
		if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(row.status)) continue;
		const comments = byTask.get(row.id) ?? [];
		// A wake is an active `@`-mention or a reply (which wakes the parent author).
		// agent_wakeup_requests carries no originating-execution id, so this is
		// derived from the execution's own comments rather than queried directly.
		const wokeSomeone = comments.some(
			(c) => extractMentionSlugs(c.content).length > 0 || c.parent_comment_id !== null,
		);
		if (wokeSomeone) continue;
		const outward: unknown[] = comments.map((c) => c.content);
		outward.push(...(input.extraOutward?.get(row.id) ?? []));
		const roster = await rosterFor(row.team_id);
		const named = new Set<string>();
		for (const text of outward) {
			for (const slug of extractPassiveMentionSlugs(text)) {
				if (roster.includes(slug)) named.add(slug);
			}
			for (const slug of detectUnlinkedTeammateReferences(text, roster)) named.add(slug);
		}
		if (named.size === 0) continue;
		findings.push({ taskId: row.id, identifier: row.identifier, named: Array.from(named) });
	}
	return findings;
}

/**
 * The warning wording for a {@link detectNoWakeExits} finding. One template, so a
 * fix reaches the run log and the chat thread alike; `subject` names the
 * execution that fell short ("this run", "This chat turn").
 */
export function formatNoWakeExitWarning(finding: NoWakeExitFinding, subject: string): string {
	const namedList = finding.named.map((s) => `**${s}**`).join(', ');
	const fixes = finding.named.map((s) => `@${s}`).join(', ');
	return (
		`${subject} woke no one on ${finding.identifier}. It named ${namedList} there ` +
		`without an active @-mention and left ${finding.identifier} open, so whoever acts ` +
		`next was never notified. If you were handing the work over, post a comment with an ` +
		`active mention (${fixes}); if you were only referring to them, no action is needed.`
	);
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
 * itself. Returns the inserted row (`RETURNING *`, so it carries `public_id`)
 * alongside the slugs the fan-out actually woke, so a caller can report what the
 * write delivered instead of inferring it. Pair `woke` with a roster through
 * {@link buildWakeReceipt} for the full receipt.
 */
export async function postAgentComment(params: PostAgentCommentParams): Promise<{
	row: { id: string; public_id: string } & Record<string, unknown>;
	woke: string[];
}> {
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
	const woke = await fireCommentWakeups({
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
	return { row, woke };
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

/** Returns the slug of the agent woken by the reply, or null if none was. */
async function fireExplicitReplyWakeup(ctx: ReplyWakeupCtx): Promise<string | null> {
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
	if (settings.rows.length === 0 || settings.rows[0].wake === false) return null;

	const parent = await db.query<{ author_member_id: string | null }>(
		'SELECT author_member_id FROM task_comments WHERE id = $1',
		[parentCommentId],
	);
	const originalAuthorId = parent.rows[0]?.author_member_id ?? null;
	if (!originalAuthorId) return null;
	if (originalAuthorId === authorMemberId) return null;
	if (alreadyWokenAgentIds.has(originalAuthorId)) return null;

	// The slug doubles as the receipt entry, so a reply-only wake (no mention text
	// anywhere) is still reported to the author as a real delivery.
	const isAgent = await db.query<{ slug: string }>('SELECT slug FROM member_agents WHERE id = $1', [
		originalAuthorId,
	]);
	if (isAgent.rows.length === 0) return null;

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
		return isAgent.rows[0].slug;
	} catch (e) {
		log.error('Failed to create reply wakeup:', e);
		return null;
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
