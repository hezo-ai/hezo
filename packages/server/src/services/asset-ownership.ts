import type { Db } from '../db/database';
import { isUuid } from '../lib/resolve';

export type AssetIdsCheck = { ok: true; ids: string[] } | { ok: false; message: string };

/**
 * Check a caller's list of asset ids against the one project they may come from.
 *
 * Every id must be a UUID, name a live (unarchived) asset in `projectId`, and
 * the list may hold at most `max` distinct ids. A repeated id is kept once. The
 * comment, chat and project-chat routes and the `create_comment` tool all attach
 * uploaded assets to something, and each used to carry its own copy of this
 * check with different gaps: a malformed id surfaced as a 500, a repeated one
 * as a rejection, and an archived one was accepted.
 */
export async function checkProjectAssetIds(
	db: Db,
	projectId: string,
	raw: unknown,
	max: number = Number.POSITIVE_INFINITY,
): Promise<AssetIdsCheck> {
	if (raw === undefined || raw === null) return { ok: true, ids: [] };
	if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string')) {
		return { ok: false, message: 'Attachments must be a list of asset ids' };
	}
	const ids = [...new Set(raw as string[])];
	if (ids.length === 0) return { ok: true, ids };
	if (ids.length > max) {
		return { ok: false, message: `At most ${max} attachments per comment` };
	}
	if (!ids.every(isUuid)) {
		return { ok: false, message: 'One or more attachment ids are not valid asset ids' };
	}
	const matched = await db.query<{ id: string }>(
		`SELECT id FROM assets
		 WHERE id = ANY($1::uuid[]) AND project_id = $2 AND archived_at IS NULL`,
		[ids, projectId],
	);
	if (matched.rows.length !== ids.length) {
		return { ok: false, message: 'One or more attachments do not belong to this project' };
	}
	return { ok: true, ids };
}

/** Link already-checked assets to a comment. Call inside the comment's own transaction. */
export async function insertCommentAttachments(
	db: Db,
	commentId: string,
	assetIds: readonly string[],
): Promise<void> {
	if (assetIds.length === 0) return;
	await db.query(
		`INSERT INTO comment_attachments (comment_id, asset_id)
		 SELECT $1::uuid, asset FROM UNNEST($2::uuid[]) AS asset`,
		[commentId, assetIds],
	);
}
