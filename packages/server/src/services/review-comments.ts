import type { ReviewComment } from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastCommentFamilyChange } from '../lib/broadcast';
import type { WebSocketManager } from './ws';

/**
 * Review comments an admin leaves on a project document or an asset while
 * viewing it. They are version-scoped: any content change to the target wipes
 * them — documents via `upsertDocument` / `restoreRevision` (services/
 * documents.ts), assets via the id-swapping overwrite in `upsertProjectAsset`
 * (lib/asset-name.ts) — so a stored comment's `quote`/`occurrence` anchor is
 * always valid for the current content.
 *
 * One table, two targets. WebSocket events keep per-target family names
 * (`document_review_comments` / `asset_review_comments`) so each side
 * invalidates only its own query keys.
 */
export type ReviewTarget =
	| { kind: 'document'; documentId: string }
	| { kind: 'asset'; assetId: string };

/** Kept for call sites that predate the doc/asset generalization. */
export type DocumentReviewCommentRow = ReviewComment;

/** Thrown when a create races a document edit (client saw a stale version). */
export class StaleDocumentError extends Error {
	constructor() {
		super('Document has changed since it was loaded');
		this.name = 'StaleDocumentError';
	}
}

/** Thrown when a create races an asset overwrite (client saw stale content). */
export class StaleAssetError extends Error {
	constructor() {
		super('Asset has changed since it was loaded');
		this.name = 'StaleAssetError';
	}
}

interface ReviewBroadcastScope {
	teamId: string;
	projectId: string;
}

function targetColumn(target: ReviewTarget): 'document_id' | 'asset_id' {
	return target.kind === 'document' ? 'document_id' : 'asset_id';
}

function targetId(target: ReviewTarget): string {
	return target.kind === 'document' ? target.documentId : target.assetId;
}

function targetFamily(target: ReviewTarget): 'document_review_comments' | 'asset_review_comments' {
	return target.kind === 'document' ? 'document_review_comments' : 'asset_review_comments';
}

export async function listReviewComments(db: Db, target: ReviewTarget): Promise<ReviewComment[]> {
	const result = await db.query<ReviewComment>(
		`SELECT * FROM review_comments WHERE ${targetColumn(target)} = $1 ORDER BY created_at ASC`,
		[targetId(target)],
	);
	return result.rows;
}

export interface CreateDocReviewCommentInput extends ReviewBroadcastScope {
	target: { kind: 'document'; documentId: string };
	quote: string;
	occurrence: number;
	comment: string;
	authorMemberId: string | null;
	/**
	 * The `documents.updated_at` the client rendered. When provided, the insert
	 * only lands if the document is still at that version (millisecond
	 * granularity — JSON round-trips truncate PG's microseconds).
	 */
	expectedDocUpdatedAt?: string;
}

export interface CreateAssetReviewCommentInput extends ReviewBroadcastScope {
	target: { kind: 'asset'; assetId: string };
	/** NULL = un-anchored whole-asset comment (non-text assets). */
	quote: string | null;
	occurrence: number;
	comment: string;
	authorMemberId: string | null;
	/**
	 * The `assets.sha256` the client rendered. When provided, the insert only
	 * lands if the asset content is unchanged. Mostly belt-and-braces: an
	 * overwrite swaps the asset id, so a stale client 404s on the id — but the
	 * guard keeps the contract identical to documents.
	 */
	expectedSha256?: string;
}

export type CreateReviewCommentInput = CreateDocReviewCommentInput | CreateAssetReviewCommentInput;

// TS does not narrow a union through a nested discriminant, so the branch
// below goes through this guard rather than `input.target.kind` directly.
function isDocCreate(input: CreateReviewCommentInput): input is CreateDocReviewCommentInput {
	return input.target.kind === 'document';
}

export async function createReviewComment(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: CreateReviewCommentInput,
): Promise<ReviewComment | null> {
	let row: ReviewComment | undefined;
	if (isDocCreate(input)) {
		const guard = input.expectedDocUpdatedAt
			? `AND date_trunc('milliseconds', d.updated_at) = date_trunc('milliseconds', $6::timestamptz)`
			: '';
		const params: unknown[] = [
			input.target.documentId,
			input.quote,
			input.occurrence,
			input.comment,
			input.authorMemberId,
		];
		if (input.expectedDocUpdatedAt) params.push(input.expectedDocUpdatedAt);

		const result = await db.query<ReviewComment>(
			`INSERT INTO review_comments (document_id, quote, occurrence, comment, author_member_id, doc_updated_at)
			 SELECT d.id, $2, $3, $4, $5, d.updated_at FROM documents d
			 WHERE d.id = $1 ${guard}
			 RETURNING *`,
			params,
		);
		row = result.rows[0];
		if (!row) {
			const doc = await db.query<{ id: string }>('SELECT id FROM documents WHERE id = $1', [
				input.target.documentId,
			]);
			if (doc.rows.length === 0) return null;
			throw new StaleDocumentError();
		}
	} else {
		const guard = input.expectedSha256 ? `AND a.sha256 = $6` : '';
		const params: unknown[] = [
			input.target.assetId,
			input.quote,
			input.occurrence,
			input.comment,
			input.authorMemberId,
		];
		if (input.expectedSha256) params.push(input.expectedSha256);

		const result = await db.query<ReviewComment>(
			`INSERT INTO review_comments (asset_id, quote, occurrence, comment, author_member_id, asset_sha256)
			 SELECT a.id, $2, $3, $4, $5, a.sha256 FROM assets a
			 WHERE a.id = $1 ${guard}
			 RETURNING *`,
			params,
		);
		row = result.rows[0];
		if (!row) {
			const asset = await db.query<{ id: string }>('SELECT id FROM assets WHERE id = $1', [
				input.target.assetId,
			]);
			if (asset.rows.length === 0) return null;
			throw new StaleAssetError();
		}
	}
	broadcastCommentFamilyChange(
		wsManager,
		input.teamId,
		input.projectId,
		targetFamily(input.target),
		'INSERT',
		row as unknown as Record<string, unknown>,
	);
	return row;
}

export interface UpdateReviewCommentInput extends ReviewBroadcastScope {
	target: ReviewTarget;
	commentId: string;
	comment: string;
}

export async function updateReviewComment(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: UpdateReviewCommentInput,
): Promise<ReviewComment | null> {
	const result = await db.query<ReviewComment>(
		`UPDATE review_comments SET comment = $1
		 WHERE id = $2 AND ${targetColumn(input.target)} = $3
		 RETURNING *`,
		[input.comment, input.commentId, targetId(input.target)],
	);
	const row = result.rows[0];
	if (!row) return null;
	broadcastCommentFamilyChange(
		wsManager,
		input.teamId,
		input.projectId,
		targetFamily(input.target),
		'UPDATE',
		row as unknown as Record<string, unknown>,
	);
	return row;
}

export interface DeleteReviewCommentInput extends ReviewBroadcastScope {
	target: ReviewTarget;
	commentId: string;
}

export async function deleteReviewComment(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: DeleteReviewCommentInput,
): Promise<boolean> {
	const result = await db.query<ReviewComment>(
		`DELETE FROM review_comments WHERE id = $1 AND ${targetColumn(input.target)} = $2 RETURNING *`,
		[input.commentId, targetId(input.target)],
	);
	const row = result.rows[0];
	if (!row) return false;
	broadcastCommentFamilyChange(
		wsManager,
		input.teamId,
		input.projectId,
		targetFamily(input.target),
		'DELETE',
		row as unknown as Record<string, unknown>,
	);
	return true;
}

export interface ClearReviewCommentsInput extends ReviewBroadcastScope {
	target: ReviewTarget;
}

export async function clearReviewComments(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: ClearReviewCommentsInput,
): Promise<number> {
	const column = targetColumn(input.target);
	const result = await db.query<{ id: string }>(
		`DELETE FROM review_comments WHERE ${column} = $1 RETURNING id`,
		[targetId(input.target)],
	);
	if (result.rows.length > 0) {
		broadcastCommentFamilyChange(
			wsManager,
			input.teamId,
			input.projectId,
			targetFamily(input.target),
			'DELETE',
			{ [column]: targetId(input.target), cleared: true },
		);
	}
	return result.rows.length;
}
