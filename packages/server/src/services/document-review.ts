import type { Db } from '../db/database';
import { broadcastCommentFamilyChange } from '../lib/broadcast';
import type { WebSocketManager } from './ws';

/**
 * Review comments an admin leaves on a project document in view mode. They are
 * version-scoped: any content change to the document wipes them (see
 * `upsertDocument` / `restoreRevision` in services/documents.ts), so a stored
 * comment's `quote`/`occurrence` anchor is always valid for the current
 * document content.
 */
export interface DocumentReviewCommentRow {
	id: string;
	document_id: string;
	quote: string;
	occurrence: number;
	comment: string;
	author_member_id: string | null;
	doc_updated_at: string;
	created_at: string;
	updated_at: string;
}

/** Thrown when a create races a document edit (client saw a stale version). */
export class StaleDocumentError extends Error {
	constructor() {
		super('Document has changed since it was loaded');
		this.name = 'StaleDocumentError';
	}
}

interface ReviewBroadcastScope {
	teamId: string;
	projectId: string;
}

export async function listReviewComments(
	db: Db,
	documentId: string,
): Promise<DocumentReviewCommentRow[]> {
	const result = await db.query<DocumentReviewCommentRow>(
		`SELECT * FROM document_review_comments WHERE document_id = $1 ORDER BY created_at ASC`,
		[documentId],
	);
	return result.rows;
}

export interface CreateReviewCommentInput extends ReviewBroadcastScope {
	documentId: string;
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

export async function createReviewComment(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: CreateReviewCommentInput,
): Promise<DocumentReviewCommentRow | null> {
	const guard = input.expectedDocUpdatedAt
		? `AND date_trunc('milliseconds', d.updated_at) = date_trunc('milliseconds', $6::timestamptz)`
		: '';
	const params: unknown[] = [
		input.documentId,
		input.quote,
		input.occurrence,
		input.comment,
		input.authorMemberId,
	];
	if (input.expectedDocUpdatedAt) params.push(input.expectedDocUpdatedAt);

	const result = await db.query<DocumentReviewCommentRow>(
		`INSERT INTO document_review_comments (document_id, quote, occurrence, comment, author_member_id, doc_updated_at)
		 SELECT d.id, $2, $3, $4, $5, d.updated_at FROM documents d
		 WHERE d.id = $1 ${guard}
		 RETURNING *`,
		params,
	);
	const row = result.rows[0];
	if (!row) {
		const doc = await db.query<{ id: string }>('SELECT id FROM documents WHERE id = $1', [
			input.documentId,
		]);
		if (doc.rows.length === 0) return null;
		throw new StaleDocumentError();
	}
	broadcastCommentFamilyChange(
		wsManager,
		input.teamId,
		input.projectId,
		'document_review_comments',
		'INSERT',
		row as unknown as Record<string, unknown>,
	);
	return row;
}

export interface UpdateReviewCommentInput extends ReviewBroadcastScope {
	documentId: string;
	commentId: string;
	comment: string;
}

export async function updateReviewComment(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: UpdateReviewCommentInput,
): Promise<DocumentReviewCommentRow | null> {
	const result = await db.query<DocumentReviewCommentRow>(
		`UPDATE document_review_comments SET comment = $1
		 WHERE id = $2 AND document_id = $3
		 RETURNING *`,
		[input.comment, input.commentId, input.documentId],
	);
	const row = result.rows[0];
	if (!row) return null;
	broadcastCommentFamilyChange(
		wsManager,
		input.teamId,
		input.projectId,
		'document_review_comments',
		'UPDATE',
		row as unknown as Record<string, unknown>,
	);
	return row;
}

export interface DeleteReviewCommentInput extends ReviewBroadcastScope {
	documentId: string;
	commentId: string;
}

export async function deleteReviewComment(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: DeleteReviewCommentInput,
): Promise<boolean> {
	const result = await db.query<DocumentReviewCommentRow>(
		`DELETE FROM document_review_comments WHERE id = $1 AND document_id = $2 RETURNING *`,
		[input.commentId, input.documentId],
	);
	const row = result.rows[0];
	if (!row) return false;
	broadcastCommentFamilyChange(
		wsManager,
		input.teamId,
		input.projectId,
		'document_review_comments',
		'DELETE',
		row as unknown as Record<string, unknown>,
	);
	return true;
}

export interface ClearReviewCommentsInput extends ReviewBroadcastScope {
	documentId: string;
}

export async function clearReviewComments(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: ClearReviewCommentsInput,
): Promise<number> {
	const result = await db.query<{ id: string }>(
		`DELETE FROM document_review_comments WHERE document_id = $1 RETURNING id`,
		[input.documentId],
	);
	if (result.rows.length > 0) {
		broadcastCommentFamilyChange(
			wsManager,
			input.teamId,
			input.projectId,
			'document_review_comments',
			'DELETE',
			{ document_id: input.documentId, cleared: true },
		);
	}
	return result.rows.length;
}
