import { AuditAction, AuditActorType, AuditEntityType, HeartbeatRunStatus } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { mapEventToAudit } from '../src/events/audit-observer';
import type { DomainEvent } from '../src/events/types';

/**
 * A3 refactor: mapEventToAudit now dispatches through the AUDIT_MAPPERS table.
 * The bus-level parity is covered by audit-events.test.ts; this pins the pure
 * mapping for one event of every family directly, so a wrong entity_type/action
 * is caught without booting an app.
 */
const scope = { teamId: 'team-1', projectId: 'proj-1' };
const actor = { actorType: AuditActorType.Agent, actorMemberId: 'member-1' };

const cases: Array<{
	name: string;
	event: DomainEvent;
	entityType: AuditEntityType;
	action: AuditAction;
	entityId: string | null;
}> = [
	{
		name: 'task.created',
		event: { type: 'task.created', taskId: 't1', identifier: 'ENG-1', ...scope, ...actor },
		entityType: AuditEntityType.Task,
		action: AuditAction.Created,
		entityId: 't1',
	},
	{
		name: 'task.updated',
		event: {
			type: 'task.updated',
			taskId: 't1',
			field: 'status',
			from: 'open',
			to: 'done',
			...scope,
			...actor,
		},
		entityType: AuditEntityType.Task,
		action: AuditAction.Updated,
		entityId: 't1',
	},
	{
		name: 'project.created',
		event: {
			type: 'project.created',
			...scope,
			...actor,
			projectId: 'p1',
			name: 'Ops',
			slug: 'ops',
		},
		entityType: AuditEntityType.Project,
		action: AuditAction.Created,
		entityId: 'p1',
	},
	{
		name: 'agent_run.started',
		event: {
			type: 'agent_run.started',
			runId: 'r1',
			taskId: 't1',
			agentMemberId: 'a1',
			triggerSource: 'heartbeat',
			...scope,
		},
		entityType: AuditEntityType.AgentRun,
		action: AuditAction.RunStarted,
		entityId: 'r1',
	},
	{
		name: 'agent_run.completed',
		event: {
			type: 'agent_run.completed',
			runId: 'r1',
			taskId: 't1',
			agentMemberId: 'a1',
			status: HeartbeatRunStatus.Succeeded,
			exitCode: 0,
			...scope,
		},
		entityType: AuditEntityType.AgentRun,
		action: AuditAction.RunCompleted,
		entityId: 'r1',
	},
	{
		name: 'asset.created',
		event: { type: 'asset.created', assetId: 'as1', filename: 'a.png', ...scope, ...actor },
		entityType: AuditEntityType.Asset,
		action: AuditAction.Created,
		entityId: 'as1',
	},
	{
		name: 'document.updated',
		event: {
			type: 'document.updated',
			documentId: 'd1',
			documentType: 'project_doc',
			...scope,
			...actor,
		},
		entityType: AuditEntityType.Document,
		action: AuditAction.Updated,
		entityId: 'd1',
	},
	{
		name: 'agent.disabled',
		event: { type: 'agent.disabled', agentMemberId: 'a1', ...scope, ...actor },
		entityType: AuditEntityType.Agent,
		action: AuditAction.Updated,
		entityId: 'a1',
	},
	{
		name: 'secret.deleted',
		event: { type: 'secret.deleted', secretId: 's1', name: 'API_KEY', ...scope, ...actor },
		entityType: AuditEntityType.Secret,
		action: AuditAction.Deleted,
		entityId: 's1',
	},
	{
		name: 'credential.requested',
		event: { type: 'credential.requested', taskId: 't1', name: 'TOKEN', ...scope, ...actor },
		entityType: AuditEntityType.Secret,
		action: AuditAction.Requested,
		entityId: null,
	},
	{
		name: 'credential.fulfilled',
		event: { type: 'credential.fulfilled', secretId: 's2', name: 'TOKEN', ...scope, ...actor },
		entityType: AuditEntityType.Secret,
		action: AuditAction.Created,
		entityId: 's2',
	},
	{
		name: 'connection.created',
		event: {
			type: 'connection.created',
			connectionId: 'c1',
			provider: 'github',
			...scope,
			...actor,
		},
		entityType: AuditEntityType.Connection,
		action: AuditAction.Created,
		entityId: 'c1',
	},
	{
		name: 'mcp_connection.deleted',
		event: {
			type: 'mcp_connection.deleted',
			connectionId: 'm1',
			name: 'Linear',
			...scope,
			...actor,
		},
		entityType: AuditEntityType.McpConnection,
		action: AuditAction.Deleted,
		entityId: 'm1',
	},
	{
		name: 'skill.created',
		event: { type: 'skill.created', skillId: 'sk1', slug: 'deploy', ...scope, ...actor },
		entityType: AuditEntityType.Skill,
		action: AuditAction.Created,
		entityId: 'sk1',
	},
];

describe('mapEventToAudit', () => {
	for (const c of cases) {
		it(`maps ${c.name} to ${c.entityType}/${c.action}`, () => {
			const audit = mapEventToAudit(c.event);
			expect(audit).not.toBeNull();
			expect(audit?.entityType).toBe(c.entityType);
			expect(audit?.action).toBe(c.action);
			expect(audit?.entityId).toBe(c.entityId);
			expect(audit?.teamId).toBe('team-1');
		});
	}

	// Archival shares the `updated` action with a content edit, so `details` is
	// what tells them apart — and the task/run are what trace an agent's
	// self-serve restore back to the run that did it.
	it('carries the archived flag and run attribution on an asset restore', () => {
		const audit = mapEventToAudit({
			type: 'asset.archived',
			assetId: 'as9',
			filename: 'reports/q3.html',
			archived: false,
			taskId: 't9',
			runId: 'r9',
			...scope,
			...actor,
		});
		expect(audit?.entityType).toBe(AuditEntityType.Asset);
		expect(audit?.action).toBe(AuditAction.Updated);
		expect(audit?.entityId).toBe('as9');
		expect(audit?.details).toMatchObject({
			filename: 'reports/q3.html',
			archived: false,
			task_id: 't9',
			run_id: 'r9',
		});
	});

	it('maps a doc archive to its own event, distinguishable from an edit', () => {
		const archived = mapEventToAudit({
			type: 'document.archived',
			documentId: 'd9',
			documentType: 'project_doc',
			slug: 'spec.md',
			title: 'Spec',
			archived: true,
			taskId: 't9',
			runId: 'r9',
			...scope,
			...actor,
		});
		expect(archived?.entityType).toBe(AuditEntityType.Document);
		expect(archived?.action).toBe(AuditAction.Updated);
		expect(archived?.entityId).toBe('d9');
		expect(archived?.details).toMatchObject({
			slug: 'spec.md',
			title: 'Spec',
			archived: true,
			task_id: 't9',
			run_id: 'r9',
		});

		// A content edit writes no `archived` key, so the two never collide.
		const edited = mapEventToAudit({
			type: 'document.updated',
			documentId: 'd9',
			documentType: 'project_doc',
			slug: 'spec.md',
			...scope,
			...actor,
		});
		expect(edited?.details).not.toHaveProperty('archived');
	});

	it('attributes system-prompt doc edits to the agent entity', () => {
		const audit = mapEventToAudit({
			type: 'document.updated',
			documentId: 'd1',
			documentType: 'agent_system_prompt',
			agentMemberId: 'a9',
			...scope,
			...actor,
		});
		expect(audit?.entityType).toBe(AuditEntityType.Agent);
		expect(audit?.entityId).toBe('a9');
		expect(audit?.details).toMatchObject({ field: 'system_prompt' });
	});
});
