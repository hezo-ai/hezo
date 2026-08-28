import { type AuditActorType, CommentContentType, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import { broadcastRowChange } from '../lib/broadcast';
import type { WebSocketManager } from './ws';

const TASK_IDENTIFIER_RE = /(?<![\w-])([A-Z][A-Z0-9]{1,3}-\d+)(?![\w-])/g;
const FENCED_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g;
const INLINE_RE = /`[^`]*`/g;

export interface TaskUpdateSnapshot {
	title: string;
	description: string | null;
	status: string;
	priority: string;
	assignee_id: string | null;
	progress_summary: string | null;
	rules: string | null;
	branch_name: string | null;
	runtime_type: string | null;
	parent_task_id: string | null;
}

export interface TaskUpdateMutationRow {
	before: TaskUpdateSnapshot;
	after: TaskUpdateSnapshot & Record<string, unknown>;
}

const TASK_UPDATE_SNAPSHOT_COLUMNS =
	'title, description, status, priority, assignee_id, progress_summary, rules, branch_name, runtime_type, parent_task_id';

/** Capture the persisted pre-update row under lock and return both versions atomically. */
export function taskUpdateMutationSql(sets: readonly string[], taskIdParam: number): string {
	return `WITH before AS MATERIALIZED (
		SELECT ${TASK_UPDATE_SNAPSHOT_COLUMNS} FROM tasks WHERE id = $${taskIdParam} FOR UPDATE
	), updated AS (
		UPDATE tasks AS target SET ${sets.join(', ')}
		FROM before WHERE target.id = $${taskIdParam}
		RETURNING target.*
	)
	SELECT to_jsonb(before) AS before,
	       to_jsonb(updated) - 'search_tsv' AS after
	FROM before CROSS JOIN updated`;
}

interface TaskUpdateEventContext {
	teamId: string;
	projectId: string;
	actorType: AuditActorType;
	actorMemberId: string | null;
	actorApiKeyId: string | null;
	taskId: string;
}

type SnapshotKey = keyof TaskUpdateSnapshot;

interface TaskUpdateAuditField {
	field: import('../events/types').TaskUpdateField;
	key: SnapshotKey;
	redact?: boolean;
	emptyIsNull?: boolean;
	label?: 'member' | 'task';
}

const TASK_UPDATE_AUDIT_FIELDS: readonly TaskUpdateAuditField[] = [
	{ field: 'title', key: 'title' },
	{ field: 'description', key: 'description', redact: true, emptyIsNull: true },
	{ field: 'status', key: 'status' },
	{ field: 'priority', key: 'priority' },
	{ field: 'assignee', key: 'assignee_id', label: 'member' },
	{ field: 'progress_summary', key: 'progress_summary', redact: true },
	{ field: 'rules', key: 'rules', redact: true },
	{ field: 'branch', key: 'branch_name' },
	{ field: 'runtime', key: 'runtime_type' },
	{ field: 'parent', key: 'parent_task_id', label: 'task' },
];

function comparableTaskValue(value: string | null, emptyIsNull: boolean): string | null {
	return emptyIsNull && value === '' ? null : value;
}

async function taskUpdateLabels(
	db: Db,
	before: TaskUpdateSnapshot,
	after: TaskUpdateSnapshot,
	includeMembers: boolean,
	includeTasks: boolean,
): Promise<{ members: Map<string, string>; tasks: Map<string, string> }> {
	const memberIds = [before.assignee_id, after.assignee_id].filter(
		(id): id is string => id !== null,
	);
	const taskIds = [before.parent_task_id, after.parent_task_id].filter(
		(id): id is string => id !== null,
	);
	const [members, tasks] = await Promise.all([
		includeMembers && memberIds.length > 0
			? db.query<{ id: string; label: string }>(
					`SELECT m.id, COALESCE(ma.title, NULLIF(m.display_name, ''), 'Admin') AS label
					   FROM members m LEFT JOIN member_agents ma ON ma.id = m.id
					  WHERE m.id = ANY($1::uuid[])`,
					[memberIds],
				)
			: Promise.resolve({ rows: [] as Array<{ id: string; label: string }> }),
		includeTasks && taskIds.length > 0
			? db.query<{ id: string; label: string }>(
					'SELECT id, identifier AS label FROM tasks WHERE id = ANY($1::uuid[])',
					[taskIds],
				)
			: Promise.resolve({ rows: [] as Array<{ id: string; label: string }> }),
	]);
	return {
		members: new Map(members.rows.map((row) => [row.id, row.label])),
		tasks: new Map(tasks.rows.map((row) => [row.id, row.label])),
	};
}

/**
 * Emit the persisted task changes shared by REST PATCH and MCP update_task.
 * Prose bodies stay off audit rows; the task thread carries bounded previews
 * for descriptions, while the Activity entry only names the field changed.
 */
export async function emitTaskUpdateEvents(
	db: Db,
	events: DomainEventBus | undefined,
	context: TaskUpdateEventContext,
	before: TaskUpdateSnapshot,
	after: TaskUpdateSnapshot,
): Promise<void> {
	if (!events) return;
	const changed = TASK_UPDATE_AUDIT_FIELDS.filter(({ key, emptyIsNull = false }) => {
		return (
			comparableTaskValue(before[key], emptyIsNull) !== comparableTaskValue(after[key], emptyIsNull)
		);
	});
	if (changed.length === 0) return;

	const labels = await taskUpdateLabels(
		db,
		before,
		after,
		changed.some(({ label }) => label === 'member'),
		changed.some(({ label }) => label === 'task'),
	);
	for (const { field, key, redact = false, label } of changed) {
		const from = before[key];
		const to = after[key];
		const labelMap = label === 'member' ? labels.members : label === 'task' ? labels.tasks : null;
		events.emit({
			type: 'task.updated',
			...context,
			field,
			from: redact ? null : from,
			to: redact ? null : to,
			...(labelMap
				? {
						fromLabel: from ? (labelMap.get(from) ?? null) : null,
						toLabel: to ? (labelMap.get(to) ?? null) : null,
					}
				: {}),
		});
	}
}

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

/**
 * Say in the thread that a run was abandoned and nobody is carrying its work.
 *
 * Posted only when the handback fails - the one outcome where work is still owed
 * and nothing is going to pick it up. A successful handback stays silent on
 * purpose: the work re-runs, and a note per interruption would bury the thread
 * on a loaded instance in events nobody has to read.
 *
 * Authored by the system, not by the agent, so `author_member_id` is null.
 * The `run_id` is what gives the reader something to act on: it is the run whose
 * card carries the Retry button.
 */
export async function recordRunAbandoned(
	db: Db,
	teamId: string,
	taskId: string,
	runId: string,
	agentSlug: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, NULL, $2::comment_content_type, $3::jsonb)
		 RETURNING *, (SELECT project_id FROM tasks WHERE id = $1) AS project_id`,
		[
			taskId,
			CommentContentType.System,
			JSON.stringify({
				kind: 'run_abandoned',
				run_id: runId,
				agent_slug: agentSlug,
				// The `text` fallback every system comment carries, for a reader on a
				// surface with no dedicated renderer (the MCP thread read, an older
				// client). The web renders the localized sentence instead.
				text: 'A run could not be started and will not be retried automatically.',
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

/**
 * Chars of each end kept on a description-change payload.
 *
 * The bodies themselves must never ride along: both the comments skeleton route
 * and the MCP `list_comments` tool hand back a system comment's `content` in
 * full, so full descriptions on the payload would inflate every comment fetch
 * and every agent's prompt context for the life of the task. Two bounded
 * previews cost ~400 chars per edit instead.
 */
const DESCRIPTION_PREVIEW_CHARS = 200;

function descriptionPreview(text: string): { preview: string; truncated: boolean } {
	if (text.length <= DESCRIPTION_PREVIEW_CHARS) return { preview: text, truncated: false };
	return { preview: text.slice(0, DESCRIPTION_PREVIEW_CHARS), truncated: true };
}

/**
 * Record a description edit on the task's own thread. Unlike a rename, the two
 * ends are unbounded, so the payload carries a capped preview of each plus the
 * full lengths — enough for the thread to show what changed without copying the
 * bodies into every comment fetch.
 */
export async function recordDescriptionChange(
	db: Db,
	teamId: string,
	taskId: string,
	oldDescription: string | null,
	newDescription: string | null,
	actorMemberId: string | null,
	actorApiKeyId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const from = oldDescription ?? '';
	const to = newDescription ?? '';
	if (from === to) return;

	const actorName = await resolveActorName(db, actorMemberId, actorApiKeyId);
	const verb =
		from === ''
			? 'added a description'
			: to === ''
				? 'cleared the description'
				: 'updated the description';
	const text = `${actorName} ${verb}`;
	const fromEnd = descriptionPreview(from);
	const toEnd = descriptionPreview(to);

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
				kind: 'description_change',
				from_preview: fromEnd.preview,
				to_preview: toEnd.preview,
				from_truncated: fromEnd.truncated,
				to_truncated: toEnd.truncated,
				from_length: from.length,
				to_length: to.length,
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
