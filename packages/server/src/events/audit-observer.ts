import type { PGlite } from '@electric-sql/pglite';
import { AuditAction, AuditActorType, AuditEntityType } from '@hezo/shared';
import { type AuditLogInput, auditLog } from '../lib/audit';
import { trackBackground } from '../lib/background';
import { logger } from '../logger';
import type { DomainEventBus } from './bus';
import type { DomainEvent } from './types';

const log = logger.child('audit-observer');

/**
 * Translate a domain event into the audit row it should produce, or `null` when
 * the event is not auditable. This is the single place that knows the audit
 * schema (entity_type / action / project_id / details mapping).
 */
export function mapEventToAudit(event: DomainEvent): AuditLogInput | null {
	switch (event.type) {
		case 'task.created':
			return row(event, AuditAction.Created, AuditEntityType.Task, event.taskId, {
				identifier: event.identifier,
			});
		case 'task.updated':
			return row(event, AuditAction.Updated, AuditEntityType.Task, event.taskId, {
				field: event.field,
				from: event.from,
				to: event.to,
				...(event.fromLabel != null ? { from_label: event.fromLabel } : {}),
				...(event.toLabel != null ? { to_label: event.toLabel } : {}),
			});
		case 'project.created':
			return row(event, AuditAction.Created, AuditEntityType.Project, event.projectId, {
				name: event.name,
				slug: event.slug,
			});
		case 'agent_run.started':
			return {
				teamId: event.teamId,
				projectId: event.projectId ?? null,
				actorType: AuditActorType.Agent,
				actorMemberId: event.agentMemberId,
				action: AuditAction.RunStarted,
				entityType: AuditEntityType.AgentRun,
				entityId: event.runId,
				details: {
					task_id: event.taskId,
					trigger_source: event.triggerSource,
					triggered_by: event.triggeredBy ?? null,
				},
			};
		case 'agent_run.completed':
			return {
				teamId: event.teamId,
				projectId: event.projectId ?? null,
				actorType: AuditActorType.Agent,
				actorMemberId: event.agentMemberId,
				action: AuditAction.RunCompleted,
				entityType: AuditEntityType.AgentRun,
				entityId: event.runId,
				details: {
					task_id: event.taskId,
					status: event.status,
					exit_code: event.exitCode,
					error: event.error ?? null,
				},
			};
		case 'asset.created':
			return row(event, AuditAction.Created, AuditEntityType.Asset, event.assetId, {
				filename: event.filename,
				task_id: event.taskId ?? null,
				run_id: event.runId ?? null,
			});
		case 'document.created':
		case 'document.updated':
		case 'document.deleted': {
			// System-prompt edits are attributed to the agent entity; other docs to the document.
			const entityType = event.agentMemberId ? AuditEntityType.Agent : AuditEntityType.Document;
			const entityId = event.agentMemberId ?? event.documentId;
			return row(event, actionFromSuffix(event.type), entityType, entityId, {
				document_type: event.documentType,
				slug: event.slug ?? null,
				title: event.title ?? null,
				...(event.agentMemberId ? { field: 'system_prompt' } : {}),
			});
		}
		case 'agent.created':
		case 'agent.updated':
		case 'agent.disabled':
		case 'agent.enabled': {
			const sub = event.type.slice('agent.'.length);
			const action = sub === 'created' ? AuditAction.Created : AuditAction.Updated;
			return row(event, action, AuditEntityType.Agent, event.agentMemberId, {
				...(sub === 'disabled' || sub === 'enabled' ? { change: sub } : {}),
				...(event.changes ? { changes: event.changes } : {}),
			});
		}
		case 'secret.created':
		case 'secret.updated':
		case 'secret.deleted':
			return row(event, actionFromSuffix(event.type), AuditEntityType.Secret, event.secretId, {
				name: event.name,
			});
		case 'credential.requested':
			return row(event, AuditAction.Requested, AuditEntityType.Secret, null, {
				name: event.name,
				task_id: event.taskId,
			});
		case 'credential.fulfilled':
			return row(event, AuditAction.Created, AuditEntityType.Secret, event.secretId, {
				name: event.name,
				via: 'credential_request',
				requesting_agent_id: event.requestingAgentId ?? null,
			});
		case 'connection.created':
		case 'connection.deleted':
			return row(
				event,
				actionFromSuffix(event.type),
				AuditEntityType.Connection,
				event.connectionId,
				{ provider: event.provider },
			);
		case 'mcp_connection.created':
		case 'mcp_connection.updated':
		case 'mcp_connection.deleted':
			return row(
				event,
				actionFromSuffix(event.type),
				AuditEntityType.McpConnection,
				event.connectionId,
				{ name: event.name, ...(event.changeKind ? { change_kind: event.changeKind } : {}) },
			);
		case 'skill.created':
		case 'skill.updated':
		case 'skill.deleted':
			return row(event, actionFromSuffix(event.type), AuditEntityType.Skill, event.skillId, {
				slug: event.slug,
				name: event.name ?? null,
			});
		default:
			return null;
	}
}

/** Register the audit observer on a bus. The only consumer that persists audit rows. */
export function registerAuditObserver(bus: DomainEventBus, db: PGlite): void {
	bus.subscribe((event) => {
		const input = mapEventToAudit(event);
		if (!input) return;
		trackBackground(
			auditLog(db, input).catch((e) =>
				log.error(`Failed to write audit row for ${event.type}:`, e),
			),
		);
	});
}

type ScopedActor = {
	teamId: string | null;
	projectId?: string | null;
	actorType: AuditActorType;
	actorMemberId: string | null;
};

function row(
	event: ScopedActor,
	action: AuditAction,
	entityType: AuditEntityType,
	entityId: string | null,
	details: Record<string, unknown>,
): AuditLogInput {
	return {
		teamId: event.teamId,
		projectId: event.projectId ?? null,
		actorType: event.actorType,
		actorMemberId: event.actorMemberId,
		action,
		entityType,
		entityId,
		details,
	};
}

function actionFromSuffix(type: string): AuditAction {
	const suffix = type.split('.')[1];
	if (suffix === 'created') return AuditAction.Created;
	if (suffix === 'updated') return AuditAction.Updated;
	return AuditAction.Deleted;
}
