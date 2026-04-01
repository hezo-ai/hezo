import type { PGlite } from '@electric-sql/pglite';
import type { AuditAction, AuditActorType, AuditEntityType } from '@hezo/shared';

export async function auditLog(
	db: PGlite,
	companyId: string,
	actorType: AuditActorType,
	actorMemberId: string | null,
	action: AuditAction,
	entityType: AuditEntityType,
	entityId: string | null,
	details?: Record<string, unknown>,
): Promise<void> {
	await db.query(
		`INSERT INTO audit_log (company_id, actor_type, actor_member_id, action, entity_type, entity_id, details)
		 VALUES ($1, $2::audit_actor_type, $3, $4, $5, $6, $7::jsonb)`,
		[
			companyId,
			actorType,
			actorMemberId,
			action,
			entityType,
			entityId,
			JSON.stringify(details ?? {}),
		],
	);
}
