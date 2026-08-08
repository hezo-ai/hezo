import { type AuditActorType, DocumentType, wsRoom } from '@hezo/shared';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import { broadcastCommentFamilyChange, broadcastRowChange } from '../lib/broadcast';
import { withTransaction } from '../lib/sql';
import type { WebSocketManager } from './ws';

/** Audit context shared by document mutations. */
export interface DocumentAuditContext {
	events?: DomainEventBus;
	actorType?: AuditActorType;
	/** Set when the actor is an API key. */
	actorApiKeyId?: string | null;
	/** The agent run's task/run, when the mutation came from one — attribution for the audit row. */
	taskId?: string | null;
	runId?: string | null;
}

function emitDocumentEvent(
	ctx: DocumentAuditContext | undefined,
	type: 'document.created' | 'document.updated' | 'document.deleted',
	row: DocumentRow,
	actorMemberId: string | null,
): void {
	if (!ctx?.events) return;
	ctx.events.emit({
		type,
		teamId: row.team_id,
		projectId: row.project_id,
		actorType: ctx.actorType ?? 'admin',
		actorMemberId,
		actorApiKeyId: ctx.actorApiKeyId ?? null,
		documentId: row.id,
		documentType: row.type,
		slug: row.slug,
		title: row.title,
		agentMemberId: row.type === DocumentType.AgentSystemPrompt ? row.member_agent_id : null,
	});
}

export interface DocumentRow {
	id: string;
	team_id: string;
	project_id: string | null;
	member_agent_id: string | null;
	type: DocumentType;
	slug: string;
	title: string;
	/** A short "what this is" line for project docs — surfaced in the list + doc header. '' when unset. */
	description: string;
	content: string;
	last_updated_by_member_id: string | null;
	/** Soft-delete stamp — null = active. Only project docs are ever archived. */
	archived_at: string | null;
	archived_by_member_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface DocumentRowWithAuthor extends DocumentRow {
	last_updated_by_name: string | null;
	/** 'agent' | 'admin' — drives the last-editor badge (docs carry no api_key attribution). */
	last_updated_by_type: string;
	/** Resolved display name of whoever archived the doc (null when active or unresolvable). */
	archived_by_name: string | null;
}

export interface DocumentRevisionRow {
	id: string;
	document_id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	author_member_id: string | null;
	created_at: string;
}

export interface DocumentRevisionRowWithAuthor extends DocumentRevisionRow {
	author_name: string | null;
	author_api_key_id: string | null;
	/** 'api_key' | 'agent' | 'admin' — drives the human/agent badge. */
	author_type: string;
}

interface ScopeProjectDoc {
	type: typeof DocumentType.ProjectDoc;
	teamId: string;
	projectId: string;
	slug: string;
}

interface ScopePreferences {
	type: typeof DocumentType.TeamPreferences;
	teamId: string;
}

interface ScopeAgentSystemPrompt {
	type: typeof DocumentType.AgentSystemPrompt;
	teamId: string;
	memberAgentId: string;
}

export type DocumentScope = ScopeProjectDoc | ScopePreferences | ScopeAgentSystemPrompt;

const PREFERENCES_SLUG = 'preferences';
const AGENT_SYSTEM_PROMPT_SLUG = 'system-prompt';

function scopeWhere(scope: DocumentScope, alias = ''): { sql: string; params: unknown[] } {
	const p = alias ? `${alias}.` : '';
	if (scope.type === DocumentType.ProjectDoc) {
		return {
			sql: `${p}type = $1 AND ${p}team_id = $2 AND ${p}project_id = $3 AND ${p}slug = $4`,
			params: [scope.type, scope.teamId, scope.projectId, scope.slug],
		};
	}
	if (scope.type === DocumentType.AgentSystemPrompt) {
		return {
			sql: `${p}type = $1 AND ${p}team_id = $2 AND ${p}member_agent_id = $3`,
			params: [scope.type, scope.teamId, scope.memberAgentId],
		};
	}
	return {
		sql: `${p}type = $1 AND ${p}team_id = $2`,
		params: [scope.type, scope.teamId],
	};
}

// Explicit column list — the generated search_tsv column (full-text index) is
// server-internal and never serialized to API responses.
const SELECT_WITH_AUTHOR = `SELECT d.id, d.team_id, d.project_id, d.member_agent_id,
	        d.type, d.slug, d.title, d.description, d.content,
	        d.last_updated_by_member_id, d.archived_at, d.archived_by_member_id,
	        d.created_at, d.updated_at,
	        COALESCE(ma.title, m.display_name) AS last_updated_by_name,
	        CASE WHEN ma.id IS NOT NULL THEN 'agent' ELSE 'admin' END AS last_updated_by_type,
	        COALESCE(maa.title, mb.display_name) AS archived_by_name
	 FROM documents d
	 LEFT JOIN members m ON m.id = d.last_updated_by_member_id
	 LEFT JOIN member_agents ma ON ma.id = d.last_updated_by_member_id
	 LEFT JOIN members mb ON mb.id = d.archived_by_member_id
	 LEFT JOIN member_agents maa ON maa.id = d.archived_by_member_id`;

export async function getDocument(
	db: Db,
	scope: DocumentScope,
): Promise<DocumentRowWithAuthor | null> {
	const where = scopeWhere(scope, 'd');
	const result = await db.query<DocumentRowWithAuthor>(
		`${SELECT_WITH_AUTHOR} WHERE ${where.sql}`,
		where.params,
	);
	return result.rows[0] ?? null;
}

export interface ListDocumentsOptions {
	type: DocumentType;
	teamId: string;
	projectId?: string;
	/**
	 * Include archived (soft-deleted) docs. Defaults to false so every listing
	 * surface — MCP, agent-run context, future callers — is active-only unless
	 * it explicitly opts in. The admin UI opts in and filters client-side.
	 */
	includeArchived?: boolean;
}

export async function listDocuments(
	db: Db,
	options: ListDocumentsOptions,
): Promise<DocumentRowWithAuthor[]> {
	const params: unknown[] = [options.type, options.teamId];
	let where = 'd.type = $1 AND d.team_id = $2';
	if (options.projectId !== undefined) {
		params.push(options.projectId);
		where += ' AND d.project_id = $3';
	}
	if (!options.includeArchived) {
		where += ' AND d.archived_at IS NULL';
	}
	const result = await db.query<DocumentRowWithAuthor>(
		`${SELECT_WITH_AUTHOR} WHERE ${where} ORDER BY COALESCE(NULLIF(d.title, ''), d.slug) ASC`,
		params,
	);
	return result.rows;
}

/**
 * A doc's metadata plus a size hint, with the body deliberately omitted.
 *
 * `content_length` is the size hint AGENTS.md asks a list route to send in
 * place of an unbounded column: a listing shows how big each doc is, and
 * `read_project_doc` serves the body (in byte windows) for the one the caller
 * actually opens.
 */
export interface DocumentSummaryRow {
	id: string;
	slug: string;
	title: string | null;
	description: string | null;
	archived_at: string | null;
	created_at: string;
	updated_at: string;
	content_length: number;
}

/**
 * List docs without their bodies.
 *
 * `listDocuments` selects `d.content` for every row, so using it to render a
 * file listing detoasts and ships every doc in the project to display a set of
 * filenames. This is the read for any surface that only needs metadata.
 */
export async function listDocumentSummaries(
	db: Db,
	options: ListDocumentsOptions,
): Promise<DocumentSummaryRow[]> {
	const params: unknown[] = [options.type, options.teamId];
	let where = 'd.type = $1 AND d.team_id = $2';
	if (options.projectId !== undefined) {
		params.push(options.projectId);
		where += ' AND d.project_id = $3';
	}
	if (!options.includeArchived) {
		where += ' AND d.archived_at IS NULL';
	}
	const result = await db.query<DocumentSummaryRow>(
		`SELECT d.id, d.slug, d.title, d.description, d.archived_at,
		        d.created_at, d.updated_at, length(d.content)::int AS content_length
		 FROM documents d
		 WHERE ${where}
		 ORDER BY COALESCE(NULLIF(d.title, ''), d.slug) ASC, d.id ASC`,
		params,
	);
	return result.rows;
}

export interface UpsertDocumentInput {
	scope: DocumentScope;
	title?: string;
	/** Optional "what this is" line for project docs. Undefined leaves an existing value untouched. */
	description?: string;
	content: string;
	changeSummary?: string;
	authorMemberId: string | null;
	/** Set when the author is an API key. */
	authorApiKeyId?: string | null;
	/** Optional audit context — when present, a document event is emitted. */
	audit?: DocumentAuditContext;
}

export type UpsertDocumentResult =
	| {
			status: 'written';
			row: DocumentRow;
			/**
			 * Whether a `changeSummary` the caller supplied actually landed on a
			 * revision. A revision is only recorded when the content changes, so a
			 * creation or a description-only update has nowhere to put one. It used
			 * to be dropped in silence; callers now surface it instead, because a
			 * changelog an agent wrote and believes is in the history, but is not,
			 * is worse than never having asked for one.
			 */
			changelogRecorded: boolean;
	  }
	/** The doc is archived — nothing was written; the caller reports "restore it first". */
	| { status: 'archived'; row: DocumentRow };

/**
 * Create the scoped document, or replace its content when it already exists.
 *
 * An **archived** doc is refused (`status: 'archived'`, no revision recorded, no
 * review comments wiped): archival keeps the slug reserved, so writing would
 * silently resurrect retired content. The rule lives here rather than at each
 * call site so every writer inherits it - including the approved-PRD handler and
 * the template appliers, which never had a check of their own. Only project docs
 * are ever archived, so it is a no-op for agent system prompts and team prefs.
 */
export async function upsertDocument(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: UpsertDocumentInput,
): Promise<UpsertDocumentResult> {
	const where = scopeWhere(input.scope, '');

	let clearedReviewComments = false;
	let existedBefore = false;
	const result = await withTransaction(db, async (): Promise<UpsertDocumentResult> => {
		const existing = await db.query<{ id: string; content: string; archived_at: string | null }>(
			`SELECT id, content, archived_at FROM documents WHERE ${where.sql}`,
			where.params,
		);
		if (existing.rows.length === 0) {
			// A revision holds the content as it was BEFORE a change, so a creation
			// has no revision to attach a changelog to.
			return {
				status: 'written',
				row: await insertDocument(db, input),
				changelogRecorded: false,
			};
		}
		existedBefore = true;
		const prior = existing.rows[0];
		if (prior.archived_at !== null) {
			const asIs = await db.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [prior.id]);
			return { status: 'archived', row: asIs.rows[0] };
		}
		const contentChanged = prior.content !== input.content;
		if (contentChanged) {
			await recordRevision(
				db,
				prior.id,
				prior.content,
				input.changeSummary ?? '',
				input.authorMemberId,
				input.authorApiKeyId ?? null,
			);
			clearedReviewComments = await wipeReviewComments(db, prior.id);
		}
		const updateResult = await db.query<DocumentRow>(
			`UPDATE documents
			 SET content = $1,
			     title = COALESCE($2, title),
			     description = COALESCE($3, description),
			     last_updated_by_member_id = $4
			 WHERE id = $5
			 RETURNING *`,
			[
				input.content,
				input.title ?? null,
				input.description ?? null,
				input.authorMemberId,
				prior.id,
			],
		);
		return { status: 'written', row: updateResult.rows[0], changelogRecorded: contentChanged };
	});

	if (result.status === 'archived') return result;
	const row = result.row;
	const action: 'INSERT' | 'UPDATE' = existedBefore ? 'UPDATE' : 'INSERT';

	broadcastRowChange(
		wsManager,
		wsRoom.team(row.team_id),
		'documents',
		action,
		row as unknown as Record<string, unknown>,
	);
	if (clearedReviewComments) broadcastReviewCommentsCleared(wsManager, row);
	emitDocumentEvent(
		input.audit,
		action === 'INSERT' ? 'document.created' : 'document.updated',
		row,
		input.authorMemberId,
	);
	return result;
}

/**
 * Archives or restores a document (the soft-delete agents use instead of
 * deletion). Idempotent: setting the state it is already in returns the row
 * with `changed: false` and emits nothing, so retried agent runs never stack
 * events. Archival is metadata — no revision is recorded and
 * last_updated_by_member_id stays untouched.
 */
export async function setDocumentArchived(
	db: Db,
	wsManager: WebSocketManager | undefined,
	scope: DocumentScope,
	archived: boolean,
	actorMemberId: string | null,
	audit?: DocumentAuditContext,
): Promise<{ row: DocumentRow; changed: boolean } | null> {
	const where = scopeWhere(scope, '');
	const prior = await db.query<{ id: string; archived_at: string | null }>(
		`SELECT id, archived_at FROM documents WHERE ${where.sql}`,
		where.params,
	);
	if (prior.rows.length === 0) return null;
	const docId = prior.rows[0].id;

	if ((prior.rows[0].archived_at !== null) === archived) {
		const asIs = await db.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [docId]);
		return { row: asIs.rows[0], changed: false };
	}

	const result = await db.query<DocumentRow>(
		`UPDATE documents
		 SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END,
		     archived_by_member_id = CASE WHEN $2 THEN $3::uuid ELSE NULL END
		 WHERE id = $1
		 RETURNING *`,
		[docId, archived, archived ? actorMemberId : null],
	);
	const row = result.rows[0];
	broadcastRowChange(
		wsManager,
		wsRoom.team(row.team_id),
		'documents',
		'UPDATE',
		row as unknown as Record<string, unknown>,
	);
	// Its own event, not `document.updated`: archiving and restoring must be
	// distinguishable from a content edit in the activity log (an agent restoring
	// a doc so it can overwrite it is exactly what an operator needs to see), and
	// the task/run make it traceable to the run that did it.
	audit?.events?.emit({
		type: 'document.archived',
		teamId: row.team_id,
		projectId: row.project_id,
		actorType: audit.actorType ?? 'admin',
		actorMemberId,
		actorApiKeyId: audit.actorApiKeyId ?? null,
		documentId: row.id,
		documentType: row.type,
		slug: row.slug,
		title: row.title,
		archived,
		taskId: audit.taskId ?? null,
		runId: audit.runId ?? null,
	});
	return { row, changed: true };
}

/**
 * Review comments are version-scoped: any content change consumes the pending
 * review (see services/review-comments.ts). Runs inside the caller's document
 * transaction so the wipe commits atomically with the edit itself. Returns
 * whether anything was deleted so the caller can broadcast after commit.
 */
async function wipeReviewComments(db: Db, documentId: string): Promise<boolean> {
	const wiped = await db.query<{ id: string }>(
		'DELETE FROM review_comments WHERE document_id = $1 RETURNING id',
		[documentId],
	);
	return wiped.rows.length > 0;
}

function broadcastReviewCommentsCleared(
	wsManager: WebSocketManager | undefined,
	row: DocumentRow,
): void {
	broadcastCommentFamilyChange(
		wsManager,
		row.team_id,
		row.project_id ?? '',
		'document_review_comments',
		'DELETE',
		{ document_id: row.id, cleared: true },
	);
}

async function insertDocument(db: Db, input: UpsertDocumentInput): Promise<DocumentRow> {
	const scope = input.scope;
	const projectId = scope.type === DocumentType.ProjectDoc ? scope.projectId : null;
	const memberAgentId = scope.type === DocumentType.AgentSystemPrompt ? scope.memberAgentId : null;
	const slug = resolveSlug(scope);
	const result = await db.query<DocumentRow>(
		`INSERT INTO documents (team_id, project_id, member_agent_id, type, slug, title, description, content, last_updated_by_member_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING *`,
		[
			scope.teamId,
			projectId,
			memberAgentId,
			scope.type,
			slug,
			input.title ?? '',
			input.description ?? '',
			input.content,
			input.authorMemberId,
		],
	);
	return result.rows[0];
}

function resolveSlug(scope: DocumentScope): string {
	if (scope.type === DocumentType.TeamPreferences) return PREFERENCES_SLUG;
	if (scope.type === DocumentType.AgentSystemPrompt) return AGENT_SYSTEM_PROMPT_SLUG;
	return scope.slug;
}

async function recordRevision(
	db: Db,
	documentId: string,
	content: string,
	changeSummary: string,
	authorMemberId: string | null,
	authorApiKeyId: string | null,
): Promise<number> {
	const next = await db.query<{ rev: number }>(
		'SELECT COALESCE(MAX(revision_number), 0)::int + 1 AS rev FROM document_revisions WHERE document_id = $1',
		[documentId],
	);
	const revisionNumber = next.rows[0].rev;
	await db.query(
		`INSERT INTO document_revisions (document_id, revision_number, content, change_summary, author_member_id, author_api_key_id)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		[documentId, revisionNumber, content, changeSummary, authorMemberId, authorApiKeyId],
	);
	return revisionNumber;
}

export async function deleteDocument(
	db: Db,
	wsManager: WebSocketManager | undefined,
	scope: DocumentScope,
	audit?: DocumentAuditContext & { actorMemberId?: string | null },
): Promise<{ id: string; type: DocumentType } | null> {
	const where = scopeWhere(scope, '');
	const result = await db.query<DocumentRow>(
		`DELETE FROM documents WHERE ${where.sql} RETURNING *`,
		where.params,
	);
	if (result.rows.length === 0) return null;
	const row = result.rows[0];
	broadcastRowChange(
		wsManager,
		wsRoom.team(row.team_id),
		'documents',
		'DELETE',
		row as unknown as Record<string, unknown>,
	);
	emitDocumentEvent(audit, 'document.deleted', row, audit?.actorMemberId ?? null);
	return { id: row.id, type: row.type };
}

export async function listRevisions(
	db: Db,
	documentId: string,
): Promise<DocumentRevisionRowWithAuthor[]> {
	const result = await db.query<DocumentRevisionRowWithAuthor>(
		`SELECT r.*,
		        COALESCE(ma.title, m.display_name, ca.name) AS author_name,
		        CASE
		            WHEN r.author_api_key_id IS NOT NULL THEN 'api_key'
		            WHEN ma.id IS NOT NULL THEN 'agent'
		            ELSE 'admin'
		        END AS author_type
		 FROM document_revisions r
		 LEFT JOIN members m ON m.id = r.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = r.author_member_id
		 LEFT JOIN api_keys ca ON ca.id = r.author_api_key_id
		 WHERE r.document_id = $1
		 ORDER BY r.revision_number DESC`,
		[documentId],
	);
	return result.rows;
}

export interface RestoreRevisionInput {
	documentId: string;
	revisionNumber: number;
	restoredByMemberId: string | null;
	/** Set when the restorer is an API key. */
	restoredByApiKeyId?: string | null;
	audit?: DocumentAuditContext;
}

export type RestoreRevisionResult =
	| { status: 'restored'; row: DocumentRow }
	/** The doc is archived — its content is frozen until it is restored. */
	| { status: 'archived' }
	/** No such document, or no such revision on it. */
	| { status: 'not_found' };

/**
 * Roll a document's content back to an earlier revision. Refused while the doc
 * is archived, for the same reason a write is: an archived doc is read-only.
 */
export async function restoreRevision(
	db: Db,
	wsManager: WebSocketManager | undefined,
	input: RestoreRevisionInput,
): Promise<RestoreRevisionResult> {
	const doc = await db.query<{
		id: string;
		content: string;
		team_id: string;
		archived_at: string | null;
	}>('SELECT id, content, team_id, archived_at FROM documents WHERE id = $1', [input.documentId]);
	if (doc.rows.length === 0) return { status: 'not_found' };
	if (doc.rows[0].archived_at !== null) return { status: 'archived' };
	const target = await db.query<{ content: string }>(
		'SELECT content FROM document_revisions WHERE document_id = $1 AND revision_number = $2',
		[input.documentId, input.revisionNumber],
	);
	if (target.rows.length === 0) return { status: 'not_found' };

	let clearedReviewComments = false;
	const row = await withTransaction(db, async () => {
		await recordRevision(
			db,
			input.documentId,
			doc.rows[0].content,
			`Restored content from revision ${input.revisionNumber}`,
			input.restoredByMemberId,
			input.restoredByApiKeyId ?? null,
		);
		if (doc.rows[0].content !== target.rows[0].content) {
			clearedReviewComments = await wipeReviewComments(db, input.documentId);
		}
		const updated = await db.query<DocumentRow>(
			`UPDATE documents
			 SET content = $1,
			     last_updated_by_member_id = $2
			 WHERE id = $3
			 RETURNING *`,
			[target.rows[0].content, input.restoredByMemberId, input.documentId],
		);
		return updated.rows[0];
	});

	broadcastRowChange(
		wsManager,
		wsRoom.team(row.team_id),
		'documents',
		'UPDATE',
		row as unknown as Record<string, unknown>,
	);
	if (clearedReviewComments) broadcastReviewCommentsCleared(wsManager, row);
	emitDocumentEvent(input.audit, 'document.updated', row, input.restoredByMemberId);
	return { status: 'restored', row };
}

/**
 * Whether the scoped document is archived, or null when there is no such doc.
 * A narrow read for callers that only need the flag — `getDocument` would pull
 * the whole unbounded `content` column to answer it.
 */
export async function isDocumentArchived(db: Db, scope: DocumentScope): Promise<boolean | null> {
	const where = scopeWhere(scope, '');
	const r = await db.query<{ archived_at: string | null }>(
		`SELECT archived_at FROM documents WHERE ${where.sql}`,
		where.params,
	);
	if (r.rows.length === 0) return null;
	return r.rows[0].archived_at !== null;
}

export async function getAgentSystemPrompt(
	db: Db,
	teamId: string,
	memberAgentId: string,
): Promise<string> {
	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		teamId,
		memberAgentId,
	});
	return doc?.content ?? '';
}

/**
 * Inserts the initial agent_system_prompt document without wrapping its own
 * transaction. Safe to call inside a caller-managed BEGIN/COMMIT (seed,
 * team bootstrap, initial agent creation). Subsequent updates must go
 * through `upsertDocument` so that revision history is recorded.
 */
export async function initAgentSystemPrompt(
	db: Db,
	teamId: string,
	memberAgentId: string,
	content: string,
	authorMemberId: string | null,
): Promise<DocumentRow> {
	return insertDocument(db, {
		scope: {
			type: DocumentType.AgentSystemPrompt,
			teamId,
			memberAgentId,
		},
		content,
		authorMemberId,
	});
}
