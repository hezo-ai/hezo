import type { PGlite } from '@electric-sql/pglite';
import { AuditAction, AuditActorType, AuditEntityType } from '@hezo/shared';
import { type AuditLogInput, auditLog } from '../lib/audit';
import { trackBackground } from '../lib/background';
import { logger } from '../logger';
import type { DomainEventBus } from './bus';
import type { DomainEvent, DomainEventType } from './types';

const log = logger.child('audit-observer');

/** Narrow the DomainEvent union to the variant(s) carrying a given `type`. */
type EventOf<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;

/**
 * One mapper per event type, returning the audit row the event should produce
 * (or `null` when it is not auditable). Keying off `DomainEventType` makes a
 * missing mapper a compile error — the same exhaustiveness the old `switch`
 * gave via its `default`, but now enforced by the type system. This is the
 * single place that knows the audit schema (entity_type / action / details).
 */
type AuditMappers = {
	[K in DomainEventType]: (event: EventOf<K>) => AuditLogInput | null;
};

// Grouped mappers — these event families share a body, so define once and reuse
// across each literal type in the map below. A function accepting the broader
// union is assignable where the narrower per-key type is expected.

function mapDocument(event: EventOf<'document.created' | 'document.updated' | 'document.deleted'>) {
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

function mapAgent(
	event: EventOf<'agent.created' | 'agent.updated' | 'agent.disabled' | 'agent.enabled'>,
) {
	const sub = event.type.slice('agent.'.length);
	const action = sub === 'created' ? AuditAction.Created : AuditAction.Updated;
	return row(event, action, AuditEntityType.Agent, event.agentMemberId, {
		...(sub === 'disabled' || sub === 'enabled' ? { change: sub } : {}),
		...(event.changes ? { changes: event.changes } : {}),
	});
}

function mapSecret(event: EventOf<'secret.created' | 'secret.updated' | 'secret.deleted'>) {
	return row(event, actionFromSuffix(event.type), AuditEntityType.Secret, event.secretId, {
		name: event.name,
	});
}

function mapConnection(event: EventOf<'connection.created' | 'connection.deleted'>) {
	return row(event, actionFromSuffix(event.type), AuditEntityType.Connection, event.connectionId, {
		provider: event.provider,
	});
}

function mapMcpConnection(
	event: EventOf<'mcp_connection.created' | 'mcp_connection.updated' | 'mcp_connection.deleted'>,
) {
	return row(
		event,
		actionFromSuffix(event.type),
		AuditEntityType.McpConnection,
		event.connectionId,
		{
			name: event.name,
			...(event.changeKind ? { change_kind: event.changeKind } : {}),
		},
	);
}

function mapSkill(event: EventOf<'skill.created' | 'skill.updated' | 'skill.deleted'>) {
	return row(event, actionFromSuffix(event.type), AuditEntityType.Skill, event.skillId, {
		slug: event.slug,
		name: event.name ?? null,
	});
}

const AUDIT_MAPPERS: AuditMappers = {
	'task.created': (event) =>
		row(event, AuditAction.Created, AuditEntityType.Task, event.taskId, {
			identifier: event.identifier,
		}),
	'task.updated': (event) =>
		row(event, AuditAction.Updated, AuditEntityType.Task, event.taskId, {
			field: event.field,
			from: event.from,
			to: event.to,
			...(event.fromLabel != null ? { from_label: event.fromLabel } : {}),
			...(event.toLabel != null ? { to_label: event.toLabel } : {}),
		}),
	'project.created': (event) =>
		row(event, AuditAction.Created, AuditEntityType.Project, event.projectId, {
			name: event.name,
			slug: event.slug,
		}),
	'agent_run.started': (event) => ({
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
	}),
	'agent_run.completed': (event) => ({
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
	}),
	'asset.created': (event) =>
		row(event, AuditAction.Created, AuditEntityType.Asset, event.assetId, {
			filename: event.filename,
			task_id: event.taskId ?? null,
			run_id: event.runId ?? null,
		}),
	'asset.deletion_requested': (event) =>
		row(event, AuditAction.Requested, AuditEntityType.Asset, event.assetIds[0] ?? null, {
			comment_id: event.commentId,
			task_id: event.taskId,
			asset_ids: event.assetIds,
			filenames: event.filenames,
		}),
	'asset.deleted': (event) =>
		row(event, AuditAction.Deleted, AuditEntityType.Asset, event.assetIds[0] ?? null, {
			asset_ids: event.assetIds,
			filenames: event.filenames,
			via: event.via,
			task_id: event.taskId ?? null,
		}),
	'document.created': mapDocument,
	'document.updated': mapDocument,
	'document.deleted': mapDocument,
	'agent.created': mapAgent,
	'agent.updated': mapAgent,
	'agent.disabled': mapAgent,
	'agent.enabled': mapAgent,
	'secret.created': mapSecret,
	'secret.updated': mapSecret,
	'secret.deleted': mapSecret,
	'credential.requested': (event) =>
		row(event, AuditAction.Requested, AuditEntityType.Secret, null, {
			name: event.name,
			task_id: event.taskId,
		}),
	'credential.fulfilled': (event) =>
		row(event, AuditAction.Created, AuditEntityType.Secret, event.secretId, {
			name: event.name,
			via: 'credential_request',
			requesting_agent_id: event.requestingAgentId ?? null,
		}),
	'connection.created': mapConnection,
	'connection.deleted': mapConnection,
	'mcp_connection.created': mapMcpConnection,
	'mcp_connection.updated': mapMcpConnection,
	'mcp_connection.deleted': mapMcpConnection,
	'skill.created': mapSkill,
	'skill.updated': mapSkill,
	'skill.deleted': mapSkill,
};

/**
 * Translate a domain event into the audit row it should produce, or `null` when
 * the event is not auditable. Dispatches through `AUDIT_MAPPERS`.
 */
export function mapEventToAudit(event: DomainEvent): AuditLogInput | null {
	// The mapped-type guarantees a mapper for every `event.type`; the cast bridges
	// the union-vs-per-key narrowing TypeScript can't infer across the lookup.
	const mapper = AUDIT_MAPPERS[event.type] as (e: DomainEvent) => AuditLogInput | null;
	return mapper(event);
}

/**
 * Entity types backed by instance-global catalogs (no project/team binding); their
 * audit rows stay instance-scoped (project_id NULL) and surface only in the
 * superuser instance view. Every other entity is project-attributable.
 */
const INSTANCE_GLOBAL_ENTITIES = new Set<AuditEntityType>([
	AuditEntityType.Secret,
	AuditEntityType.Connection,
	AuditEntityType.McpConnection,
	AuditEntityType.Skill,
]);

/** Resolve a team's single project (teams are 1:1 with projects). */
async function resolveProjectIdForTeam(db: PGlite, teamId: string): Promise<string | null> {
	const r = await db.query<{ id: string }>(`SELECT id FROM projects WHERE team_id = $1 LIMIT 1`, [
		teamId,
	]);
	return r.rows[0]?.id ?? null;
}

/** Register the audit observer on a bus. The only consumer that persists audit rows. */
export function registerAuditObserver(bus: DomainEventBus, db: PGlite): void {
	bus.subscribe((event) => {
		const input = mapEventToAudit(event);
		if (!input) return;
		trackBackground(
			(async () => {
				// Team-only events (agent lifecycle, team documents) carry just a team;
				// attribute them to the team's single project so they appear in its
				// Activity. Instance-global catalogs stay instance-scoped.
				if (
					input.projectId == null &&
					input.teamId &&
					!INSTANCE_GLOBAL_ENTITIES.has(input.entityType)
				) {
					input.projectId = await resolveProjectIdForTeam(db, input.teamId);
				}
				await auditLog(db, input);
			})().catch((e) => log.error(`Failed to write audit row for ${event.type}:`, e)),
		);
	});
}

type ScopedActor = {
	teamId: string | null;
	projectId?: string | null;
	actorType: AuditActorType;
	actorMemberId: string | null;
	actorApiKeyId?: string | null;
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
		actorApiKeyId: event.actorApiKeyId ?? null,
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
