import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, wsRoom } from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import type { WebSocketManager } from './ws';

const ISSUE_IDENTIFIER_RE = /(?<![\w-])([A-Z][A-Z0-9]{1,3}-\d+)(?![\w-])/g;
const FENCED_RE = /(?:^|\n)(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)(?=\n|$)/g;
const INLINE_RE = /`[^`]*`/g;

export function extractIssueIdentifiers(text: string | null | undefined): string[] {
	if (!text) return [];
	const stripped = text.replace(FENCED_RE, ' ').replace(INLINE_RE, ' ');
	const out = new Set<string>();
	ISSUE_IDENTIFIER_RE.lastIndex = 0;
	let m = ISSUE_IDENTIFIER_RE.exec(stripped);
	while (m !== null) {
		out.add(m[1]);
		m = ISSUE_IDENTIFIER_RE.exec(stripped);
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

export async function recordStatusChange(
	db: PGlite,
	companyId: string,
	issueId: string,
	oldStatus: string,
	newStatus: string,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	if (oldStatus === newStatus) return;
	const actorName = await resolveActorName(db, actorMemberId);
	const text = `${actorName} changed status from ${oldStatus} to ${newStatus}`;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
		[
			issueId,
			actorMemberId,
			CommentContentType.System,
			JSON.stringify({
				kind: 'status_change',
				from: oldStatus,
				to: newStatus,
				actor_id: actorMemberId,
				text,
			}),
		],
	);
	if (r.rows[0] && wsManager) {
		broadcastRowChange(wsManager, wsRoom.company(companyId), 'issue_comments', 'INSERT', r.rows[0]);
	}
}

export async function recordTitleChange(
	db: PGlite,
	companyId: string,
	issueId: string,
	oldTitle: string,
	newTitle: string,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	if (oldTitle === newTitle) return;
	const actorName = await resolveActorName(db, actorMemberId);
	const text = `${actorName} renamed from "${oldTitle}" to "${newTitle}"`;
	const r = await db.query<Record<string, unknown>>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
		[
			issueId,
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
		broadcastRowChange(wsManager, wsRoom.company(companyId), 'issue_comments', 'INSERT', r.rows[0]);
	}
}

export async function recordAssigneeChange(
	db: PGlite,
	companyId: string,
	issueId: string,
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
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
		[
			issueId,
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
		broadcastRowChange(wsManager, wsRoom.company(companyId), 'issue_comments', 'INSERT', r.rows[0]);
	}
}

export async function recordIssueLinks(
	db: PGlite,
	companyId: string,
	sourceIssueId: string,
	text: string | null | undefined,
	actorMemberId: string | null,
	wsManager: WebSocketManager | undefined,
): Promise<void> {
	const ids = extractIssueIdentifiers(text);
	if (ids.length === 0) return;

	const targets = await db.query<{ id: string; identifier: string }>(
		`SELECT id, identifier FROM issues
		  WHERE company_id = $1 AND identifier = ANY($2::text[]) AND id <> $3`,
		[companyId, ids, sourceIssueId],
	);
	if (targets.rows.length === 0) return;

	const source = await db.query<{ identifier: string }>(
		`SELECT identifier FROM issues WHERE id = $1`,
		[sourceIssueId],
	);
	const sourceIdentifier = source.rows[0]?.identifier ?? '';
	const actorName = await resolveActorName(db, actorMemberId);

	for (const target of targets.rows) {
		const exists = await db.query(
			`SELECT 1 FROM issue_comments
			  WHERE issue_id = $1
			    AND content_type = 'system'
			    AND content->>'kind' = 'issue_link'
			    AND content->>'source_issue_id' = $2
			  LIMIT 1`,
			[target.id, sourceIssueId],
		);
		if (exists.rows.length > 0) continue;

		const linkText = `Linked from ${sourceIdentifier} by ${actorName}`;
		const r = await db.query<Record<string, unknown>>(
			`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
			[
				target.id,
				actorMemberId,
				CommentContentType.System,
				JSON.stringify({
					kind: 'issue_link',
					source_issue_id: sourceIssueId,
					source_identifier: sourceIdentifier,
					actor_id: actorMemberId,
					text: linkText,
				}),
			],
		);
		if (r.rows[0] && wsManager) {
			broadcastRowChange(
				wsManager,
				wsRoom.company(companyId),
				'issue_comments',
				'INSERT',
				r.rows[0],
			);
		}
	}
}
