import type { PGlite } from '@electric-sql/pglite';
import type { AuditAction, AuditActorType, AuditEntityType } from '@hezo/shared';

export interface AuditLogInput {
	/** NULL for instance-level actions not bound to any team. */
	teamId: string | null;
	/** NULL for team-level and instance-level events. */
	projectId?: string | null;
	actorType: AuditActorType;
	actorMemberId: string | null;
	/** Set when the actor is a connected agent; mutually exclusive with actorMemberId. */
	actorConnectedAgentId?: string | null;
	action: AuditAction;
	entityType: AuditEntityType;
	entityId: string | null;
	details?: Record<string, unknown>;
}

export async function auditLog(db: PGlite, input: AuditLogInput): Promise<void> {
	await db.query(
		`INSERT INTO audit_log (team_id, project_id, actor_type, actor_member_id, actor_connected_agent_id, action, entity_type, entity_id, details)
		 VALUES ($1, $2, $3::audit_actor_type, $4, $5, $6, $7, $8, $9::jsonb)`,
		[
			input.teamId,
			input.projectId ?? null,
			input.actorType,
			input.actorMemberId,
			input.actorConnectedAgentId ?? null,
			input.action,
			input.entityType,
			input.entityId,
			JSON.stringify(input.details ?? {}),
		],
	);
}
