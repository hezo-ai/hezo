import type { PGlite } from '@electric-sql/pglite';
import { DocumentType, wsRoom } from '@hezo/shared';
import { broadcastRowChange } from '../lib/broadcast';
import type { WebSocketManager } from './ws';

export interface DocumentRow {
	id: string;
	company_id: string;
	project_id: string | null;
	member_agent_id: string | null;
	type: DocumentType;
	slug: string;
	title: string;
	content: string;
	last_updated_by_member_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface DocumentRowWithAuthor extends DocumentRow {
	last_updated_by_name: string | null;
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
}

interface ScopeProjectDoc {
	type: typeof DocumentType.ProjectDoc;
	companyId: string;
	projectId: string;
	slug: string;
}

interface ScopeKbDoc {
	type: typeof DocumentType.KbDoc;
	companyId: string;
	slug: string;
}

interface ScopePreferences {
	type: typeof DocumentType.CompanyPreferences;
	companyId: string;
}

interface ScopeAgentSystemPrompt {
	type: typeof DocumentType.AgentSystemPrompt;
	companyId: string;
	memberAgentId: string;
}

export type DocumentScope =
	| ScopeProjectDoc
	| ScopeKbDoc
	| ScopePreferences
	| ScopeAgentSystemPrompt;

const PREFERENCES_SLUG = 'preferences';
const AGENT_SYSTEM_PROMPT_SLUG = 'system-prompt';

function scopeWhere(scope: DocumentScope, alias = ''): { sql: string; params: unknown[] } {
	const p = alias ? `${alias}.` : '';
	if (scope.type === DocumentType.ProjectDoc) {
		return {
			sql: `${p}type = $1 AND ${p}company_id = $2 AND ${p}project_id = $3 AND ${p}slug = $4`,
			params: [scope.type, scope.companyId, scope.projectId, scope.slug],
		};
	}
	if (scope.type === DocumentType.KbDoc) {
		return {
			sql: `${p}type = $1 AND ${p}company_id = $2 AND ${p}slug = $3`,
			params: [scope.type, scope.companyId, scope.slug],
		};
	}
	if (scope.type === DocumentType.AgentSystemPrompt) {
		return {
			sql: `${p}type = $1 AND ${p}company_id = $2 AND ${p}member_agent_id = $3`,
			params: [scope.type, scope.companyId, scope.memberAgentId],
		};
	}
	return {
		sql: `${p}type = $1 AND ${p}company_id = $2`,
		params: [scope.type, scope.companyId],
	};
}

// Explicit column list — `embedding` (vector(384)) is server-internal and
// adds ~4KB of float noise per row in JSON responses for zero downstream value.
const SELECT_WITH_AUTHOR = `SELECT d.id, d.company_id, d.project_id, d.member_agent_id,
	        d.type, d.slug, d.title, d.content,
	        d.last_updated_by_member_id, d.created_at, d.updated_at,
	        COALESCE(ma.title, m.display_name) AS last_updated_by_name
	 FROM documents d
	 LEFT JOIN members m ON m.id = d.last_updated_by_member_id
	 LEFT JOIN member_agents ma ON ma.id = d.last_updated_by_member_id`;

export async function getDocument(
	db: PGlite,
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
	companyId: string;
	projectId?: string;
}

export async function listDocuments(
	db: PGlite,
	options: ListDocumentsOptions,
): Promise<DocumentRowWithAuthor[]> {
	const params: unknown[] = [options.type, options.companyId];
	let where = 'd.type = $1 AND d.company_id = $2';
	if (options.projectId !== undefined) {
		params.push(options.projectId);
		where += ' AND d.project_id = $3';
	}
	const result = await db.query<DocumentRowWithAuthor>(
		`${SELECT_WITH_AUTHOR} WHERE ${where} ORDER BY COALESCE(NULLIF(d.title, ''), d.slug) ASC`,
		params,
	);
	return result.rows;
}

export interface UpsertDocumentInput {
	scope: DocumentScope;
	title?: string;
	content: string;
	changeSummary?: string;
	authorMemberId: string | null;
}

export async function upsertDocument(
	db: PGlite,
	wsManager: WebSocketManager | undefined,
	input: UpsertDocumentInput,
): Promise<DocumentRow> {
	const where = scopeWhere(input.scope, '');
	const existing = await db.query<{ id: string; content: string }>(
		`SELECT id, content FROM documents WHERE ${where.sql}`,
		where.params,
	);

	const action: 'INSERT' | 'UPDATE' = existing.rows.length === 0 ? 'INSERT' : 'UPDATE';
	let row: DocumentRow;

	await db.query('BEGIN');
	try {
		if (existing.rows.length === 0) {
			const insert = await insertDocument(db, input);
			row = insert;
		} else {
			const prior = existing.rows[0];
			if (prior.content !== input.content) {
				await recordRevision(
					db,
					prior.id,
					prior.content,
					input.changeSummary ?? '',
					input.authorMemberId,
				);
			}
			const updateResult = await db.query<DocumentRow>(
				`UPDATE documents
				 SET content = $1,
				     title = COALESCE($2, title),
				     last_updated_by_member_id = $3
				 WHERE id = $4
				 RETURNING *`,
				[input.content, input.title ?? null, input.authorMemberId, prior.id],
			);
			row = updateResult.rows[0];
		}
		await db.query('COMMIT');
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}

	broadcastRowChange(
		wsManager,
		wsRoom.company(row.company_id),
		'documents',
		action,
		row as unknown as Record<string, unknown>,
	);
	return row;
}

async function insertDocument(db: PGlite, input: UpsertDocumentInput): Promise<DocumentRow> {
	const scope = input.scope;
	const projectId = scope.type === DocumentType.ProjectDoc ? scope.projectId : null;
	const memberAgentId = scope.type === DocumentType.AgentSystemPrompt ? scope.memberAgentId : null;
	const slug = resolveSlug(scope);
	const result = await db.query<DocumentRow>(
		`INSERT INTO documents (company_id, project_id, member_agent_id, type, slug, title, content, last_updated_by_member_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING *`,
		[
			scope.companyId,
			projectId,
			memberAgentId,
			scope.type,
			slug,
			input.title ?? '',
			input.content,
			input.authorMemberId,
		],
	);
	return result.rows[0];
}

function resolveSlug(scope: DocumentScope): string {
	if (scope.type === DocumentType.CompanyPreferences) return PREFERENCES_SLUG;
	if (scope.type === DocumentType.AgentSystemPrompt) return AGENT_SYSTEM_PROMPT_SLUG;
	return scope.slug;
}

async function recordRevision(
	db: PGlite,
	documentId: string,
	content: string,
	changeSummary: string,
	authorMemberId: string | null,
): Promise<number> {
	const next = await db.query<{ rev: number }>(
		'SELECT COALESCE(MAX(revision_number), 0)::int + 1 AS rev FROM document_revisions WHERE document_id = $1',
		[documentId],
	);
	const revisionNumber = next.rows[0].rev;
	await db.query(
		`INSERT INTO document_revisions (document_id, revision_number, content, change_summary, author_member_id)
		 VALUES ($1, $2, $3, $4, $5)`,
		[documentId, revisionNumber, content, changeSummary, authorMemberId],
	);
	return revisionNumber;
}

export async function deleteDocument(
	db: PGlite,
	wsManager: WebSocketManager | undefined,
	scope: DocumentScope,
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
		wsRoom.company(row.company_id),
		'documents',
		'DELETE',
		row as unknown as Record<string, unknown>,
	);
	return { id: row.id, type: row.type };
}

export async function listRevisions(
	db: PGlite,
	documentId: string,
): Promise<DocumentRevisionRowWithAuthor[]> {
	const result = await db.query<DocumentRevisionRowWithAuthor>(
		`SELECT r.*, COALESCE(ma.title, m.display_name) AS author_name
		 FROM document_revisions r
		 LEFT JOIN members m ON m.id = r.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = r.author_member_id
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
}

export async function restoreRevision(
	db: PGlite,
	wsManager: WebSocketManager | undefined,
	input: RestoreRevisionInput,
): Promise<DocumentRow | null> {
	const doc = await db.query<{ id: string; content: string; company_id: string }>(
		'SELECT id, content, company_id FROM documents WHERE id = $1',
		[input.documentId],
	);
	if (doc.rows.length === 0) return null;
	const target = await db.query<{ content: string }>(
		'SELECT content FROM document_revisions WHERE document_id = $1 AND revision_number = $2',
		[input.documentId, input.revisionNumber],
	);
	if (target.rows.length === 0) return null;

	let row: DocumentRow;
	await db.query('BEGIN');
	try {
		await recordRevision(
			db,
			input.documentId,
			doc.rows[0].content,
			`Restored to revision ${input.revisionNumber}`,
			input.restoredByMemberId,
		);
		const updated = await db.query<DocumentRow>(
			`UPDATE documents
			 SET content = $1,
			     last_updated_by_member_id = $2
			 WHERE id = $3
			 RETURNING *`,
			[target.rows[0].content, input.restoredByMemberId, input.documentId],
		);
		row = updated.rows[0];
		await db.query('COMMIT');
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}

	broadcastRowChange(
		wsManager,
		wsRoom.company(row.company_id),
		'documents',
		'UPDATE',
		row as unknown as Record<string, unknown>,
	);
	return row;
}

export async function getAgentSystemPrompt(
	db: PGlite,
	companyId: string,
	memberAgentId: string,
): Promise<string> {
	const doc = await getDocument(db, {
		type: DocumentType.AgentSystemPrompt,
		companyId,
		memberAgentId,
	});
	return doc?.content ?? '';
}

/**
 * Inserts the initial agent_system_prompt document without wrapping its own
 * transaction. Safe to call inside a caller-managed BEGIN/COMMIT (seed,
 * company bootstrap, initial agent creation). Subsequent updates must go
 * through `upsertDocument` so that revision history is recorded.
 */
export async function initAgentSystemPrompt(
	db: PGlite,
	companyId: string,
	memberAgentId: string,
	content: string,
	authorMemberId: string | null,
): Promise<DocumentRow> {
	return insertDocument(db, {
		scope: {
			type: DocumentType.AgentSystemPrompt,
			companyId,
			memberAgentId,
		},
		content,
		authorMemberId,
	});
}
