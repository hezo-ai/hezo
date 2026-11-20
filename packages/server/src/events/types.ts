import type { AuditActorType, HeartbeatRunStatus } from '@hezo/shared';

/**
 * Domain events emitted by business logic and consumed by observers (today:
 * the audit and OTLP observers).
 *
 * An event carries what a consumer needs to act on it, not a full record. The
 * audit observer can write its row from the payload alone, but a consumer that
 * needs the run's stored record — `agent_run.completed` leaves out timestamps,
 * tokens, model and provider — reads the finished row by id instead. That row
 * is current at emit time because the finalizer commits before it emits.
 *
 * `teamId` is nullable for instance-level actions (e.g. an Admin managing an
 * instance secret / connector / skill). `projectId` is set only for
 * project-scoped events.
 */

interface Scope {
	teamId: string | null;
	projectId?: string | null;
}

interface Actor {
	actorType: AuditActorType;
	actorMemberId: string | null;
	/** Set when the actor is an API key; mutually exclusive with actorMemberId. */
	actorApiKeyId?: string | null;
}

/**
 * `description` carries no from/to: a description has no size ceiling, so the
 * bodies stay off the audit row (the task thread's description-change comment
 * holds bounded previews instead).
 */
export type TaskUpdateField =
	| 'title'
	| 'description'
	| 'status'
	| 'priority'
	| 'assignee'
	| 'progress_summary'
	| 'rules'
	| 'branch'
	| 'runtime'
	| 'parent';

export type DomainEvent =
	| ({ type: 'task.created'; taskId: string; identifier: string } & Scope & Actor)
	| ({
			type: 'task.updated';
			taskId: string;
			field: TaskUpdateField;
			from: string | null;
			to: string | null;
			/** Resolved display names for the assignee field, where from/to hold member ids. */
			fromLabel?: string | null;
			toLabel?: string | null;
	  } & Scope &
			Actor)
	| ({ type: 'project.created'; projectId: string; name: string; slug: string } & Scope & Actor)
	| ({
			type: 'agent_run.started';
			runId: string;
			taskId: string | null;
			agentMemberId: string;
			triggerSource: string | null;
			triggeredBy?: string | null;
	  } & Scope)
	| ({
			type: 'agent_run.completed';
			runId: string;
			taskId: string | null;
			agentMemberId: string;
			status: HeartbeatRunStatus;
			exitCode: number | null;
			error?: string | null;
	  } & Scope)
	| ({
			type: 'asset.created';
			assetId: string;
			filename: string;
			taskId?: string | null;
			runId?: string | null;
	  } & Scope &
			Actor)
	| ({
			type: 'asset.deletion_requested';
			commentId: string;
			taskId: string;
			assetIds: string[];
			filenames: string[];
	  } & Scope &
			Actor)
	| ({
			type: 'asset.deleted';
			assetIds: string[];
			filenames: string[];
			via: 'admin_delete' | 'deletion_request';
			taskId?: string | null;
	  } & Scope &
			Actor)
	| ({
			type: 'asset.archived';
			assetId: string;
			filename: string;
			/** true = archived, false = restored. */
			archived: boolean;
			taskId?: string | null;
			runId?: string | null;
	  } & Scope &
			Actor)
	| ({
			type: 'document.created' | 'document.updated' | 'document.deleted';
			documentId: string | null;
			documentType: string;
			slug?: string | null;
			title?: string | null;
			/** When set, the audit row is attributed to the agent entity (system prompt edits). */
			agentMemberId?: string | null;
	  } & Scope &
			Actor)
	/** Deliberately separate from document.updated so a restore is distinguishable from an edit. */
	| ({
			type: 'document.archived';
			documentId: string;
			documentType: string;
			slug?: string | null;
			title?: string | null;
			/** true = archived, false = restored. */
			archived: boolean;
			taskId?: string | null;
			runId?: string | null;
	  } & Scope &
			Actor)
	| ({
			type: 'agent.created' | 'agent.updated' | 'agent.disabled' | 'agent.enabled';
			agentMemberId: string;
			changes?: string[];
	  } & Scope &
			Actor)
	| ({
			type: 'secret.created' | 'secret.updated' | 'secret.deleted';
			secretId: string;
			name: string;
	  } & Scope &
			Actor)
	| ({ type: 'credential.requested'; taskId: string | null; name: string } & Scope & Actor)
	| ({
			type: 'credential.fulfilled';
			secretId: string;
			name: string;
			requestingAgentId?: string | null;
	  } & Scope &
			Actor)
	| ({
			type: 'connection.created' | 'connection.deleted';
			connectionId: string;
			provider: string;
	  } & Scope &
			Actor)
	| ({
			type: 'mcp_connection.created' | 'mcp_connection.updated' | 'mcp_connection.deleted';
			connectionId: string;
			name: string;
			changeKind?: string;
	  } & Scope &
			Actor)
	| ({
			type: 'skill.created' | 'skill.updated' | 'skill.deleted';
			skillId: string;
			slug: string;
			name?: string | null;
	  } & Scope &
			Actor);

export type DomainEventType = DomainEvent['type'];

export type DomainEventHandler = (event: DomainEvent) => void;
