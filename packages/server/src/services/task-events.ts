import { CommentContentType, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastRowChange } from '../lib/broadcast';
import type { WebSocketManager } from './ws';

const TASK_IDENTIFIER_RE = /(?<![\w-])([A-Z][A-Z0-9]{1,3}-\d+)(?![\w-])/g;
const FENCED_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g;
const INLINE_RE = /`[^`]*`/g;

export function extractTaskIdentifiers(text: string | null | undefined): string[] {
	if (!text) return [];
	const stripped = text.replace(FENCED_RE, ' ').replace(INLINE_RE, ' ');
	const out = new Set<string>();
	TASK_IDENTIFIER_RE.lastIndex = 0;
	let m = TASK_IDENTIFIER_RE.exec(stripped);
	while (m !== null) {
		out.add(m[1]);
		m = TASK_IDENTIFIER_RE.exec(stripped);
	}
	return Array.from(out);
}

/**
 * Human-readable name for an action's actor. An API key (approved
 * external MCP client) is named from `api_keys`; a member from its
 * agent title / display name; everything else is "Admin".
 */
export async function resolveActorName(
	db: Db,
	actorMemberId: string | null,
	actorApiKeyId: string | null = null,
): Promise<string> {
	if (actorApiKeyId) {
		const r = await db.query<{ name: string | null }>('SELECT name FROM api_keys WHERE id = $1', [
			actorApiKeyId,
		]);
		return r.rows[0]?.name ?? 'Admin';
	}
	if (!actorMemberId) return 'Admin';
	const r = await db.query<{ name: string | null }>(
		`SELECT COALESCE(ma.title, NULLIF(m.display_name, ''), 'Admin') AS name
		   FROM members m LEFT JOIN member_agents ma ON ma.id = m.id
		  WHERE m.id = $1`,
		[actorMemberId],
	);
	return r.rows[0]?.name ?? 'Admin';
}

interface ActorInfo {
	name: string;
	kind: 'agent' | 'user' | 'admin' | 'api_key';
	slug: string | null;
}

async function resolveActor(
	db: Db,
	actorMemberId: string | null,
	actorApiKeyId: string | null = null,
): Promise<ActorInfo> {
	if (actorApiKeyId) {
		const r = await db.query<{ name: string | null }>('SELECT name FROM api_keys WHERE id = $1', [
			actorApiKeyId,
		]);
		return { name: r.rows[0]?.name ?? 'Admin', kind: 'api_key', slug: null };
	}
	if (!actorMemberId) return { name: 'Admin', kind: 'admin', slug: null };
	const r = await db.query<{
		name: string | null;
		member_type: string | null;
		agent_slug: string | null;
	}>(
		`SELECT COALESCE(ma.title, NULLIF(m.display_name, ''), 'Admin') AS name,
		        m.member_type,
		        ma.slug AS agent_slug
		   FROM members m
		   LEFT JOIN member_agents ma ON ma.id = m.id
		  WHERE m.id = $1`,
		[actorMemberId],
	);
	const row = r.rows[0];
	if (!row) return { name: 'Admin', kind: 'admin', slug: null };
	if (row.agent_slug) return { name: row.name ?? 'Agent', kind: 'agent', slug: row.agent_slug };
	return { name: row.name ?? 'Admin', kind: 'user', slug: null };
}

export interface CascadeContext {
	kind: 'auto_unblock';
	triggeredByTaskId: string;
	triggeredByIdentifier: string;
	triggeredByProjectSlug: string;
}

export async function recordStatusChange(
	db: Db,
	teamId: string,
	taskId: string,
	oldStatus: string,
	newStatus: string,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager: WebSocketManager | undefined,
	cascade?: CascadeContext,
): Promise<void> {
	if (oldStatus === newStatus) return;
	const isCascade = cascade !== undefined;
	const authorId = isCascade ? null : actorMemberId;
	const authorApiKeyId = isCascade ? null : actorApiKeyId;
	const content: Record<string, unknown> = {
		kind: 'status_change',
		from: oldStatus,
		to: newStatus,
		actor_id: authorId,
	};
	if (cascade) {
		content.cascade = cascade.kind;
		content.triggered_by_task_id = cascade.triggeredByTaskId;
		content.triggered_by_identifier = cascade.triggeredByIdentifier;
		content.triggered_by_project_slug = cascade.triggeredByProjectSlug;
		content.triggered_by_actor_id = actorMemberId;
	}
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, content_type, content)
		 VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
		 RETURNING *, (SELECT project_id FROM tasks WHERE id = $1) AS project_id`,
		[taskId, authorId, authorApiKeyId, CommentContentType.System, JSON.stringify(content)],
	);
	if (r.rows[0] && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'task_comments', 'INSERT', r.rows[0]);
	}
}

export async function recordRunTerminated(
	db: Db,
	teamId: string,
	taskId: string,
	runId: string,
	reason: string,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const actorName = await resolveActorName(db, actorMemberId, actorApiKeyId);
	const text = `${actorName} terminated agent run — ${reason}`;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, content_type, content)
		 VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
		 RETURNING *, (SELECT project_id FROM tasks WHERE id = $1) AS project_id`,
		[
			taskId,
			actorMemberId,
			actorApiKeyId,
			CommentContentType.System,
			JSON.stringify({
				kind: 'run_terminated',
				run_id: runId,
				reason,
				actor_id: actorMemberId,
				actor_name: actorName,
				text,
			}),
		],
	);
	if (r.rows[0] && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'task_comments', 'INSERT', r.rows[0]);
	}
}

export async function recordWakeupCancelled(
	db: Db,
	teamId: string,
	taskId: string,
	wakeupId: string,
	agentName: string,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const actorName = await resolveActorName(db, actorMemberId, actorApiKeyId);
	const text = `${actorName} cancelled queued run for ${agentName}`;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, content_type, content)
		 VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
		 RETURNING *, (SELECT project_id FROM tasks WHERE id = $1) AS project_id`,
		[
			taskId,
			actorMemberId,
			actorApiKeyId,
			CommentContentType.System,
			JSON.stringify({
				kind: 'wakeup_cancelled',
				wakeup_id: wakeupId,
				actor_id: actorMemberId,
				actor_name: actorName,
				agent_name: agentName,
				text,
			}),
		],
	);
	if (r.rows[0] && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'task_comments', 'INSERT', r.rows[0]);
	}
}

export async function recordTitleChange(
	db: Db,
	teamId: string,
	taskId: string,
	oldTitle: string,
	newTitle: string,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	if (oldTitle === newTitle) return;
	const actorName = await resolveActorName(db, actorMemberId, actorApiKeyId);
	const text = `${actorName} renamed from "${oldTitle}" to "${newTitle}"`;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, content_type, content)
		 VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
		 RETURNING *, (SELECT project_id FROM tasks WHERE id = $1) AS project_id`,
		[
			taskId,
			actorMemberId,
			actorApiKeyId,
			CommentContentType.System,
			JSON.stringify({
				kind: 'title_change',
				from: oldTitle,
				to: newTitle,
				actor_id: actorMemberId,
				text,
			}),
		],
	);
	if (r.rows[0] && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'task_comments', 'INSERT', r.rows[0]);
	}
}

export async function recordAssigneeChange(
	db: Db,
	teamId: string,
	taskId: string,
	oldAssigneeId: string | null,
	newAssigneeId: string | null,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<{ fromName: string; toName: string } | null> {
	if (oldAssigneeId === newAssigneeId) return null;
	const [fromName, toName, actorName] = await Promise.all([
		resolveActorName(db, oldAssigneeId),
		resolveActorName(db, newAssigneeId),
		resolveActorName(db, actorMemberId, actorApiKeyId),
	]);
	const text = `${actorName} reassigned from ${fromName} to ${toName}`;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, content_type, content)
		 VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
		 RETURNING *, (SELECT project_id FROM tasks WHERE id = $1) AS project_id`,
		[
			taskId,
			actorMemberId,
			actorApiKeyId,
			CommentContentType.System,
			JSON.stringify({
				kind: 'assignee_change',
				from_id: oldAssigneeId,
				to_id: newAssigneeId,
				from_name: fromName,
				to_name: toName,
				actor_id: actorMemberId,
				text,
			}),
		],
	);
	if (r.rows[0] && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'task_comments', 'INSERT', r.rows[0]);
	}
	return { fromName, toName };
}

/**
 * Record a change of parentage on the task's own thread.
 *
 * Both ends are looked up in one query rather than one each, and the project
 * slugs ride along on the payload so the web renderer can link the identifiers
 * without a second fetch (the same trick `recordTaskLinks` uses below).
 */
export async function recordParentChange(
	db: Db,
	teamId: string,
	taskId: string,
	oldParentId: string | null,
	newParentId: string | null,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<{ fromIdentifier: string | null; toIdentifier: string | null } | null> {
	if (oldParentId === newParentId) return null;

	const lookupIds = [oldParentId, newParentId].filter((id): id is string => id !== null);
	const [ends, actorName] = await Promise.all([
		lookupIds.length > 0
			? db.query<{ id: string; identifier: string; project_slug: string }>(
					`SELECT t.id, t.identifier, p.slug AS project_slug
					   FROM tasks t JOIN projects p ON p.id = t.project_id
					  WHERE t.id = ANY($1::uuid[])`,
					[lookupIds],
				)
			: Promise.resolve({ rows: [] as { id: string; identifier: string; project_slug: string }[] }),
		resolveActorName(db, actorMemberId, actorApiKeyId),
	]);
	const byId = new Map(ends.rows.map((r) => [r.id, r]));
	const from = oldParentId ? (byId.get(oldParentId) ?? null) : null;
	const to = newParentId ? (byId.get(newParentId) ?? null) : null;
	const fromIdentifier = from?.identifier ?? null;
	const toIdentifier = to?.identifier ?? null;

	const text =
		fromIdentifier && toIdentifier
			? `${actorName} moved this task from ${fromIdentifier} to ${toIdentifier}`
			: toIdentifier
				? `${actorName} nested this task under ${toIdentifier}`
				: fromIdentifier
					? `${actorName} promoted this task to top level (was under ${fromIdentifier})`
					: `${actorName} promoted this task to top level`;

	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, content_type, content)
		 VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
		 RETURNING *, (SELECT project_id FROM tasks WHERE id = $1) AS project_id`,
		[
			taskId,
			actorMemberId,
			actorApiKeyId,
			CommentContentType.System,
			JSON.stringify({
				kind: 'parent_change',
				from_id: oldParentId,
				to_id: newParentId,
				from_identifier: fromIdentifier,
				to_identifier: toIdentifier,
				from_project_slug: from?.project_slug ?? null,
				to_project_slug: to?.project_slug ?? null,
				actor_id: actorMemberId,
				text,
			}),
		],
	);
	if (r.rows[0] && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'task_comments', 'INSERT', r.rows[0]);
	}
	return { fromIdentifier, toIdentifier };
}

/**
 * Where in the source task the mention was written.
 *
 * A description has no sub-location to point at, so it records exactly as it
 * always has. A comment does, and its `public_id` is the `#comment-<id>` anchor
 * the timeline already scrolls to, so the recorded event can link straight at
 * the sentence that created the relationship instead of only at its task.
 */
export type TaskLinkOrigin = { kind: 'description' } | { kind: 'comment'; commentPublicId: string };

export async function recordTaskLinks(
	db: Db,
	teamId: string,
	sourceTaskId: string,
	text: string | null | undefined,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager: WebSocketManager | undefined,
	origin: TaskLinkOrigin = { kind: 'description' },
): Promise<void> {
	const ids = extractTaskIdentifiers(text);
	if (ids.length === 0) return;

	const targets = await db.query<{ id: string; identifier: string }>(
		`SELECT id, identifier FROM tasks
		  WHERE team_id = $1 AND identifier = ANY($2::text[]) AND id <> $3`,
		[teamId, ids, sourceTaskId],
	);
	if (targets.rows.length === 0) return;

	const source = await db.query<{ identifier: string; project_slug: string }>(
		`SELECT i.identifier, p.slug AS project_slug
		   FROM tasks i
		   JOIN projects p ON p.id = i.project_id
		  WHERE i.id = $1`,
		[sourceTaskId],
	);
	const sourceIdentifier = source.rows[0]?.identifier ?? '';
	const sourceProjectSlug = source.rows[0]?.project_slug ?? '';
	const actor = await resolveActor(db, actorMemberId, actorApiKeyId);

	for (const target of targets.rows) {
		const exists = await db.query(
			`SELECT 1 FROM task_comments
			  WHERE task_id = $1
			    AND content_type = 'system'
			    AND content->>'kind' = 'task_link'
			    AND content->>'source_task_id' = $2
			  LIMIT 1`,
			[target.id, sourceTaskId],
		);
		if (exists.rows.length > 0) continue;

		// `text` stays English on purpose: it is what agents read back through the
		// MCP comment tools and what the client's generic fallback prints. The web
		// renderer builds its own sentence from the structured fields below, which
		// is what lets that sentence be translated.
		const linkText =
			origin.kind === 'comment'
				? `Linked from a comment on ${sourceIdentifier} by ${actor.name}`
				: `Linked from ${sourceIdentifier} by ${actor.name}`;
		const r = await db.query<Record<string, unknown>>(
			`INSERT INTO task_comments (task_id, author_member_id, author_api_key_id, content_type, content)
			 VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb)
		 RETURNING *, (SELECT project_id FROM tasks WHERE id = $1) AS project_id`,
			[
				target.id,
				actorMemberId,
				actorApiKeyId,
				CommentContentType.System,
				JSON.stringify({
					kind: 'task_link',
					source_task_id: sourceTaskId,
					source_identifier: sourceIdentifier,
					source_project_slug: sourceProjectSlug,
					// Both derived from the one `origin` argument so they cannot disagree.
					source_kind: origin.kind,
					source_comment_public_id: origin.kind === 'comment' ? origin.commentPublicId : null,
					actor_id: actorMemberId,
					actor_name: actor.name,
					actor_kind: actor.kind,
					actor_slug: actor.slug,
					text: linkText,
				}),
			],
		);
		if (r.rows[0] && wsManager) {
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'task_comments', 'INSERT', r.rows[0]);
		}
	}
}
