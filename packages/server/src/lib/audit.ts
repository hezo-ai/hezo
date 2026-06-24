import type { PGlite } from '@electric-sql/pglite';
import type { AuditAction, AuditActorType, AuditEntityType } from '@hezo/shared';

export interface AuditLogInput {
	/**
	 * Scopes the event to a single project. NULL = an instance-level action not
	 * bound to any project (e.g. an Admin managing an instance-global secret /
	 * connector / skill) — visible only in the superuser instance view.
	 */
	projectId?: string | null;
	/**
	 * Transient resolution hint, NOT persisted. Team-only events (agent lifecycle,
	 * team documents) carry the team so the audit observer can resolve the team's
	 * single project (teams are 1:1 with projects) before writing the row.
	 */
	teamId?: string | null;
	actorType: AuditActorType;
	actorMemberId: string | null;
	/** Set when the actor is an API key (the MCP credential); mutually exclusive with actorMemberId. */
	actorApiKeyId?: string | null;
	action: AuditAction;
	entityType: AuditEntityType;
	entityId: string | null;
	details?: Record<string, unknown>;
}

export async function auditLog(db: PGlite, input: AuditLogInput): Promise<void> {
	await db.query(
		`INSERT INTO audit_log (project_id, actor_type, actor_member_id, actor_api_key_id, action, entity_type, entity_id, details)
		 VALUES ($1, $2::audit_actor_type, $3, $4, $5, $6, $7, $8::jsonb)`,
		[
			input.projectId ?? null,
			input.actorType,
			input.actorMemberId,
			input.actorApiKeyId ?? null,
			input.action,
			input.entityType,
			input.entityId,
			JSON.stringify(input.details ?? {}),
		],
	);
}
