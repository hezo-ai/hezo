import { createHash, randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { ApiKeyStatus, AuditAction, AuditActorType, AuditEntityType } from '@hezo/shared';
import { auditLog } from '../lib/audit';
import { logger } from '../logger';
import { safeCompareHex } from '../middleware/auth';

const log = logger.child('api-keys');

/** Public-safe shape returned by list/create (never exposes `key_hash`). */
export interface ApiKeyRow {
	id: string;
	name: string;
	client_info: Record<string, unknown>;
	prefix: string;
	status: string;
	approved_at: string | null;
	last_used_at: string | null;
	created_at: string;
}

const PUBLIC_COLUMNS =
	'id, name, client_info, prefix, status, approved_at, last_used_at, created_at';

function hashKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

/** A fresh `hezo_` token plus the 8-char prefix and SHA-256 hash we persist. */
function mintToken(): { token: string; prefix: string; keyHash: string } {
	const token = `hezo_${randomBytes(16).toString('hex')}`;
	return { token, prefix: token.slice(5, 13), keyHash: hashKey(token) };
}

/**
 * Admin-minted key: created `approved` (active immediately) and attributed to the
 * superuser who minted it. Returns the one-time raw token.
 */
export async function createApiKey(
	db: PGlite,
	input: { name: string; createdByUserId: string },
): Promise<ApiKeyRow & { key: string }> {
	const { token, prefix, keyHash } = mintToken();
	const result = await db.query<ApiKeyRow>(
		`INSERT INTO api_keys (name, prefix, key_hash, status, approved_at, approved_by_user_id)
		 VALUES ($1, $2, $3, $4, now(), $5)
		 RETURNING ${PUBLIC_COLUMNS}`,
		[input.name.trim(), prefix, keyHash, ApiKeyStatus.Approved, input.createdByUserId],
	);
	const row = result.rows[0];
	await tryAudit(db, {
		action: AuditAction.Created,
		actorType: AuditActorType.Admin,
		entityId: row.id,
		details: { name: row.name },
	});
	return { ...row, key: token };
}

/**
 * Self-registration: create a `pending` key and return its one-time raw token. The
 * row grants no access until an admin approves it.
 */
export async function registerApiKey(
	db: PGlite,
	input: { name: string; clientInfo?: Record<string, unknown> },
): Promise<{ id: string; prefix: string; token: string; status: string }> {
	const { token, prefix, keyHash } = mintToken();
	const result = await db.query<{ id: string; prefix: string; status: string }>(
		`INSERT INTO api_keys (name, client_info, prefix, key_hash, status)
		 VALUES ($1, $2::jsonb, $3, $4, $5)
		 RETURNING id, prefix, status`,
		[
			input.name.trim(),
			JSON.stringify(input.clientInfo ?? {}),
			prefix,
			keyHash,
			ApiKeyStatus.Pending,
		],
	);
	const row = result.rows[0];
	await tryAudit(db, {
		action: AuditAction.Requested,
		actorType: AuditActorType.System,
		entityId: row.id,
		details: { name: input.name.trim() },
	});
	return { id: row.id, prefix: row.prefix, token, status: row.status };
}

/** Resolve a key's status from its raw bearer token (for registration polling). */
export async function getApiKeyStatusByToken(
	db: PGlite,
	token: string,
): Promise<{ status: string } | null> {
	if (!token.startsWith('hezo_')) return null;
	const prefix = token.slice(5, 13);
	const result = await db.query<{ key_hash: string; status: string }>(
		'SELECT key_hash, status FROM api_keys WHERE prefix = $1',
		[prefix],
	);
	if (result.rows.length === 0) return null;
	if (!safeCompareHex(hashKey(token), result.rows[0].key_hash)) return null;
	return { status: result.rows[0].status };
}

export async function listApiKeys(db: PGlite): Promise<ApiKeyRow[]> {
	const result = await db.query<ApiKeyRow>(
		`SELECT ${PUBLIC_COLUMNS} FROM api_keys ORDER BY created_at DESC`,
	);
	return result.rows;
}

export async function approveApiKey(
	db: PGlite,
	id: string,
	approvedByUserId: string,
): Promise<ApiKeyRow | null> {
	const result = await db.query<ApiKeyRow>(
		`UPDATE api_keys
		 SET status = $2, approved_at = now(), approved_by_user_id = $3
		 WHERE id = $1
		 RETURNING ${PUBLIC_COLUMNS}`,
		[id, ApiKeyStatus.Approved, approvedByUserId],
	);
	const row = result.rows[0] ?? null;
	if (row) {
		await tryAudit(db, {
			action: AuditAction.Updated,
			actorType: AuditActorType.Admin,
			entityId: id,
			details: { name: row.name, status: ApiKeyStatus.Approved },
		});
	}
	return row;
}

/** Revoke. Deleting the row makes the token fail on the next request. */
export async function deleteApiKey(db: PGlite, id: string): Promise<boolean> {
	const result = await db.query<{ id: string; name: string }>(
		'DELETE FROM api_keys WHERE id = $1 RETURNING id, name',
		[id],
	);
	const row = result.rows[0];
	if (!row) return false;
	await tryAudit(db, {
		action: AuditAction.Deleted,
		actorType: AuditActorType.Admin,
		entityId: id,
		details: { name: row.name },
	});
	return true;
}

/** Instance-level audit write; logged-and-swallowed so it never breaks the op. */
async function tryAudit(
	db: PGlite,
	input: {
		action: (typeof AuditAction)[keyof typeof AuditAction];
		actorType: (typeof AuditActorType)[keyof typeof AuditActorType];
		entityId: string;
		details?: Record<string, unknown>;
	},
): Promise<void> {
	try {
		await auditLog(db, {
			teamId: null,
			actorType: input.actorType,
			actorMemberId: null,
			action: input.action,
			entityType: AuditEntityType.ApiKey,
			entityId: input.entityId,
			details: input.details,
		});
	} catch (e) {
		log.error('failed to write api-key audit log:', e);
	}
}
