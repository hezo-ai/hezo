import type { PGlite } from '@electric-sql/pglite';
import { AuditActorType, AuditEntityType } from '@hezo/shared';
import { logger } from '../../logger';

const log = logger.child('egress-audit');

export interface EgressAuditEvent {
	companyId: string;
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

export async function recordEgressEvent(db: PGlite, event: EgressAuditEvent): Promise<void> {
	try {
		await db.query(
			`INSERT INTO audit_log (company_id, actor_type, actor_member_id, action, entity_type, entity_id, details)
			 VALUES ($1, $2::audit_actor_type, $3, 'egress_request', $4, NULL, $5::jsonb)`,
			[
				event.companyId,
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
