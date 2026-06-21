import { createHash, randomBytes } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { AuditAction, AuditActorType, AuditEntityType, ConnectedAgentStatus } from '@hezo/shared';
import { auditLog } from '../lib/audit';
import { logger } from '../logger';
import { safeCompareHex } from '../middleware/auth';

const log = logger.child('connected-agents');

/** Public-safe shape returned by list/register (never exposes `token_hash`). */
export interface ConnectedAgentRow {
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

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Self-registration: create a `pending` connected agent and return its one-time
 * raw token. The token is `hezoc_` + 16 random bytes; only the 8-char prefix and
 * the SHA-256 hash are stored. The row grants no access until an admin approves.
 */
export async function registerConnectedAgent(
	db: PGlite,
	input: { name: string; clientInfo?: Record<string, unknown> },
): Promise<{ id: string; prefix: string; token: string; status: string }> {
	const token = `hezoc_${randomBytes(16).toString('hex')}`;
	const prefix = token.slice(6, 14);
	const tokenHash = hashToken(token);

	const result = await db.query<{ id: string; prefix: string; status: string }>(
		`INSERT INTO connected_agents (name, client_info, prefix, token_hash, status)
		 VALUES ($1, $2::jsonb, $3, $4, $5)
		 RETURNING id, prefix, status`,
		[
			input.name.trim(),
			JSON.stringify(input.clientInfo ?? {}),
			prefix,
			tokenHash,
			ConnectedAgentStatus.Pending,
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

/** Resolve a connected agent's status from its raw bearer token (for polling). */
export async function getConnectionStatusByToken(
	db: PGlite,
	token: string,
): Promise<{ status: string } | null> {
	if (!token.startsWith('hezoc_')) return null;
	const prefix = token.slice(6, 14);
	const result = await db.query<{ token_hash: string; status: string }>(
		'SELECT token_hash, status FROM connected_agents WHERE prefix = $1',
		[prefix],
	);
	if (result.rows.length === 0) return null;
	if (!safeCompareHex(hashToken(token), result.rows[0].token_hash)) return null;
	return { status: result.rows[0].status };
}

export async function listConnectedAgents(db: PGlite): Promise<ConnectedAgentRow[]> {
	const result = await db.query<ConnectedAgentRow>(
		`SELECT ${PUBLIC_COLUMNS} FROM connected_agents ORDER BY created_at DESC`,
	);
	return result.rows;
}

export async function approveConnectedAgent(
	db: PGlite,
	id: string,
	approvedByUserId: string,
): Promise<ConnectedAgentRow | null> {
	const result = await db.query<ConnectedAgentRow>(
		`UPDATE connected_agents
		 SET status = $2, approved_at = now(), approved_by_user_id = $3
		 WHERE id = $1
		 RETURNING ${PUBLIC_COLUMNS}`,
		[id, ConnectedAgentStatus.Approved, approvedByUserId],
	);
	const row = result.rows[0] ?? null;
	if (row) {
		await tryAudit(db, {
			action: AuditAction.Updated,
			actorType: AuditActorType.Admin,
			entityId: id,
			details: { name: row.name, status: ConnectedAgentStatus.Approved },
		});
	}
	return row;
}

/** Disconnect (revoke). Deleting the row makes the token fail on the next request. */
export async function deleteConnectedAgent(db: PGlite, id: string): Promise<boolean> {
	const result = await db.query<{ id: string; name: string }>(
		'DELETE FROM connected_agents WHERE id = $1 RETURNING id, name',
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
			entityType: AuditEntityType.ConnectedAgent,
			entityId: input.entityId,
			details: input.details,
		});
	} catch (e) {
		log.error('failed to write connected-agent audit log:', e);
	}
}
