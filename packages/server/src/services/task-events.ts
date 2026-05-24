import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, wsRoom } from '@hezo/shared';
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

async function resolveActorName(db: PGlite, actorMemberId: string | null): Promise<string> {
	if (!actorMemberId) return 'Board';
	const r = await db.query<{ name: string | null }>(
		`SELECT COALESCE(ma.title, NULLIF(m.display_name, ''), 'Board') AS name
		   FROM members m LEFT JOIN member_agents ma ON ma.id = m.id
		  WHERE m.id = $1`,
		[actorMemberId],
	);
	return r.rows[0]?.name ?? 'Board';
}

interface ActorInfo {
	name: string;
	kind: 'agent' | 'user' | 'board';
	slug: string | null;
}

async function resolveActor(db: PGlite, actorMemberId: string | null): Promise<ActorInfo> {
	if (!actorMemberId) return { name: 'Board', kind: 'board', slug: null };
	const r = await db.query<{
		name: string | null;
		member_type: string | null;
		agent_slug: string | null;
	}>(
		`SELECT COALESCE(ma.title, NULLIF(m.display_name, ''), 'Board') AS name,
		        m.member_type,
		        ma.slug AS agent_slug
		   FROM members m
		   LEFT JOIN member_agents ma ON ma.id = m.id
		  WHERE m.id = $1`,
		[actorMemberId],
	);
	const row = r.rows[0];
	if (!row) return { name: 'Board', kind: 'board', slug: null };
	if (row.agent_slug) return { name: row.name ?? 'Agent', kind: 'agent', slug: row.agent_slug };
	return { name: row.name ?? 'Board', kind: 'user', slug: null };
}

export async function recordStatusChange(
	db: PGlite,
	teamId: string,
	taskId: string,
	oldStatus: string,
	newStatus: string,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	if (oldStatus === newStatus) return;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
		[
			taskId,
			actorMemberId,
			CommentContentType.System,
			JSON.stringify({
				kind: 'status_change',
				from: oldStatus,
				to: newStatus,
				actor_id: actorMemberId,
			}),
		],
	);
	if (r.rows[0] && wsManager) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'task_comments', 'INSERT', r.rows[0]);
	}
}

export async function recordTitleChange(
	db: PGlite,
	teamId: string,
	taskId: string,
	oldTitle: string,
	newTitle: string,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	if (oldTitle === newTitle) return;
	const actorName = await resolveActorName(db, actorMemberId);
	const text = `${actorName} renamed from "${oldTitle}" to "${newTitle}"`;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
		[
			taskId,
			actorMemberId,
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
	db: PGlite,
	teamId: string,
	taskId: string,
	oldAssigneeId: string | null,
	newAssigneeId: string | null,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	if (oldAssigneeId === newAssigneeId) return;
	const [fromName, toName, actorName] = await Promise.all([
		resolveActorName(db, oldAssigneeId),
		resolveActorName(db, newAssigneeId),
		resolveActorName(db, actorMemberId),
	]);
	const text = `${actorName} reassigned from ${fromName} to ${toName}`;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
		[
			taskId,
			actorMemberId,
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
}

export async function recordTaskLinks(
	db: PGlite,
	teamId: string,
	sourceTaskId: string,
	text: string | null | undefined,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
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
	const actor = await resolveActor(db, actorMemberId);

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

		const linkText = `Linked from ${sourceIdentifier} by ${actor.name}`;
		const r = await db.query<Record<string, unknown>>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
			[
				target.id,
				actorMemberId,
				CommentContentType.System,
				JSON.stringify({
					kind: 'task_link',
					source_task_id: sourceTaskId,
					source_identifier: sourceIdentifier,
					source_project_slug: sourceProjectSlug,
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
