import type { PGlite } from '@electric-sql/pglite';
import { isReactionKind, type ReactionKind } from '@hezo/shared';

export interface ReactionMember {
	id: string;
	slug: string | null;
	display_name: string | null;
}

export interface ReactionGroup {
	kind: ReactionKind;
	members: ReactionMember[];
	you_reacted: boolean;
}

export type ReactionFailure = {
	ok: false;
	code: 'NOT_FOUND' | 'INVALID_KIND' | 'FORBIDDEN';
	message: string;
};

export type ReactionSuccess = {
	ok: true;
	reactions: ReactionGroup[];
};

export type ReactionResult = ReactionSuccess | ReactionFailure;

export interface MutateReactionParams {
	db: PGlite;
	teamId: string;
	taskId: string;
	commentId: string;
	kind: string;
	memberId: string;
}

async function verifyCommentBelongsToTaskAndTeam(
	db: PGlite,
	commentId: string,
	taskId: string,
	teamId: string,
): Promise<boolean> {
	const row = await db.query<{ id: string }>(
		`SELECT ic.id FROM task_comments ic
		 JOIN tasks i ON i.id = ic.task_id
		 WHERE ic.id = $1 AND ic.task_id = $2 AND i.team_id = $3`,
		[commentId, taskId, teamId],
	);
	return row.rows.length > 0;
}

async function loadReactionsForComment(
	db: PGlite,
	commentId: string,
	viewerMemberId: string | null,
): Promise<ReactionGroup[]> {
	const rows = await db.query<{
		kind: string;
		member_id: string;
		slug: string | null;
		display_name: string | null;
		created_at: string;
	}>(
		`SELECT cr.kind, cr.member_id, ma.slug, m.display_name, cr.created_at
		 FROM comment_reactions cr
		 JOIN members m ON m.id = cr.member_id
		 LEFT JOIN member_agents ma ON ma.id = cr.member_id
		 WHERE cr.comment_id = $1
		 ORDER BY cr.created_at ASC`,
		[commentId],
	);
	const groups = new Map<string, ReactionMember[]>();
	for (const r of rows.rows) {
		const list = groups.get(r.kind) ?? [];
		list.push({ id: r.member_id, slug: r.slug, display_name: r.display_name });
		groups.set(r.kind, list);
	}
	return Array.from(groups.entries()).map(([kind, members]) => ({
		kind: kind as ReactionKind,
		members,
		you_reacted: viewerMemberId ? members.some((m) => m.id === viewerMemberId) : false,
	}));
}

export async function addCommentReaction(params: MutateReactionParams): Promise<ReactionResult> {
	const { db, teamId, taskId, commentId, kind, memberId } = params;
	if (!isReactionKind(kind)) {
		return { ok: false, code: 'INVALID_KIND', message: `Unknown reaction kind: ${kind}` };
	}
	const exists = await verifyCommentBelongsToTaskAndTeam(db, commentId, taskId, teamId);
	if (!exists) {
		return { ok: false, code: 'NOT_FOUND', message: 'Comment not found' };
	}
	await db.query(
		`INSERT INTO comment_reactions (comment_id, member_id, kind)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (comment_id, member_id, kind) DO NOTHING`,
		[commentId, memberId, kind],
	);
	return { ok: true, reactions: await loadReactionsForComment(db, commentId, memberId) };
}

export async function removeCommentReaction(params: MutateReactionParams): Promise<ReactionResult> {
	const { db, teamId, taskId, commentId, kind, memberId } = params;
	if (!isReactionKind(kind)) {
		return { ok: false, code: 'INVALID_KIND', message: `Unknown reaction kind: ${kind}` };
	}
	const exists = await verifyCommentBelongsToTaskAndTeam(db, commentId, taskId, teamId);
	if (!exists) {
		return { ok: false, code: 'NOT_FOUND', message: 'Comment not found' };
	}
	await db.query(
		'DELETE FROM comment_reactions WHERE comment_id = $1 AND member_id = $2 AND kind = $3',
		[commentId, memberId, kind],
	);
	return { ok: true, reactions: await loadReactionsForComment(db, commentId, memberId) };
}

/**
 * Loads every reaction on every comment of an task in one query, keyed by
 * comment id, so a comments-list response can include reactions without an
 * N+1.
 */
export async function loadReactionsForTask(
	db: PGlite,
	taskId: string,
	viewerMemberId: string | null = null,
): Promise<Map<string, ReactionGroup[]>> {
	const rows = await db.query<{
		comment_id: string;
		kind: string;
		member_id: string;
		slug: string | null;
		display_name: string | null;
		created_at: string;
	}>(
		`SELECT cr.comment_id, cr.kind, cr.member_id, ma.slug, m.display_name, cr.created_at
		 FROM comment_reactions cr
		 JOIN task_comments ic ON ic.id = cr.comment_id
		 JOIN members m ON m.id = cr.member_id
		 LEFT JOIN member_agents ma ON ma.id = cr.member_id
		 WHERE ic.task_id = $1
		 ORDER BY cr.created_at ASC`,
		[taskId],
	);
	const byComment = new Map<string, Map<string, ReactionMember[]>>();
	for (const r of rows.rows) {
		let groups = byComment.get(r.comment_id);
		if (!groups) {
			groups = new Map();
			byComment.set(r.comment_id, groups);
		}
		const list = groups.get(r.kind) ?? [];
		list.push({ id: r.member_id, slug: r.slug, display_name: r.display_name });
		groups.set(r.kind, list);
	}
	const out = new Map<string, ReactionGroup[]>();
	for (const [commentId, groups] of byComment) {
		out.set(
			commentId,
			Array.from(groups.entries()).map(([kind, members]) => ({
				kind: kind as ReactionKind,
				members,
				you_reacted: viewerMemberId ? members.some((m) => m.id === viewerMemberId) : false,
			})),
		);
	}
	return out;
}
