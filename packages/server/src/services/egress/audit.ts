import { AuditActorType, AuditEntityType } from '@hezo/shared';
import type { Db } from '../../db/database';
import { logger } from '../../logger';

const log = logger.child('egress-audit');

export interface EgressAuditEvent {
	teamId: string;
	agentId: string;
	runId: string;
	host: string;
	method: string;
	urlPath: string;
	statusCode: number | null;
	substitutionsCount: number;
	secretNamesUsed: string[];
	error?: string | null;
}

export async function recordEgressEvent(db: Db, event: EgressAuditEvent): Promise<void> {
	try {
		// Egress is scoped to the run's team, which backs exactly one project (1:1);
		// attribute the row to that project so it shows on the project Activity log.
		const project = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE team_id = $1 LIMIT 1`,
			[event.teamId],
		);
		await db.query(
			`INSERT INTO audit_log (project_id, actor_type, actor_member_id, action, entity_type, entity_id, details)
			 VALUES ($1, $2::audit_actor_type, $3, 'egress_request', $4, NULL, $5::jsonb)`,
			[
				project.rows[0]?.id ?? null,
				AuditActorType.Agent,
				event.agentId,
				AuditEntityType.EgressRequest,
				JSON.stringify({
					run_id: event.runId,
					host: event.host,
					method: event.method,
					url_path: event.urlPath,
					status_code: event.statusCode,
					substitutions_count: event.substitutionsCount,
					secret_names_used: event.secretNamesUsed,
					error: event.error ?? null,
				}),
			],
		);
	} catch (err) {
		log.error('Failed to write egress audit row', err);
	}
}
