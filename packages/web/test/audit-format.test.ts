import { expect, test } from 'vitest';
import type { AuditEntry } from '../src/hooks/use-audit-log';
import { auditEntryLink, describeAuditEntry } from '../src/lib/audit-format';

function entry(overrides: Partial<AuditEntry>): AuditEntry {
	return {
		id: 'a1',
		team_id: 't1',
		project_id: 'p1',
		actor_type: 'admin',
		actor_member_id: null,
		actor_name: 'Alice',
		team_name: 'Acme',
		team_slug: 'acme',
		project_slug: 'ops',
		action: 'created',
		entity_type: 'task',
		entity_id: 'e1',
		entity_identifier: 'OP-1',
		ref_task_identifier: null,
		details: {},
		created_at: new Date(0).toISOString(),
		...overrides,
	};
}

test('describes a task creation with its identifier', () => {
	expect(describeAuditEntry(entry({ action: 'created', entity_type: 'task' }))).toBe(
		'Created task OP-1',
	);
});

test('describes a status change with human labels', () => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'status', from: 'in_progress', to: 'done' },
	});
	expect(describeAuditEntry(e)).toBe('Changed status of OP-1 from In Progress to Done');
});

test('describes a rename with from/to titles', () => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'title', from: 'Foo', to: 'Bar' },
	});
	expect(describeAuditEntry(e)).toBe('Renamed OP-1 from "Foo" to "Bar"');
});

test('describes a reassignment with resolved names', () => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'assignee', from_label: 'Bob', to_label: 'Alice' },
	});
	expect(describeAuditEntry(e)).toBe('Reassigned OP-1 from Bob to Alice');
});

test('describes an agent run against its referenced task', () => {
	const e = entry({
		action: 'run_started',
		entity_type: 'agent_run',
		entity_identifier: null,
		ref_task_identifier: 'OP-2',
		details: { task_id: 'uuid' },
	});
	expect(describeAuditEntry(e)).toBe('Started an agent run on OP-2');
});

test('describes a secret creation by name', () => {
	const e = entry({
		action: 'created',
		entity_type: 'secret',
		entity_identifier: null,
		details: { name: 'OPENAI_KEY' },
	});
	expect(describeAuditEntry(e)).toBe('Created secret OPENAI_KEY');
});

test('falls back to a generic sentence for unmapped entities', () => {
	const e = entry({
		action: 'created',
		entity_type: 'egress_request',
		entity_identifier: null,
		details: {},
	});
	expect(describeAuditEntry(e)).toBe('Created egress request');
});

test('links a task row to the task route with a lowercased identifier', () => {
	const link = auditEntryLink(entry({ entity_type: 'task', entity_identifier: 'OP-1' }));
	expect(link).toEqual({
		to: '/teams/$teamId/projects/$projectId/tasks/$taskId',
		params: { teamId: 'acme', projectId: 'ops', taskId: 'op-1' },
	});
});

test('links a team-scoped secret to team credentials, instance to the instance page', () => {
	const teamScoped = auditEntryLink(
		entry({ entity_type: 'secret', entity_identifier: null, team_slug: 'acme' }),
	);
	expect(teamScoped).toEqual({
		to: '/teams/$teamId/settings/credentials',
		params: { teamId: 'acme' },
	});

	const instanceScoped = auditEntryLink(
		entry({ entity_type: 'secret', entity_identifier: null, team_id: null, team_slug: null }),
	);
	expect(instanceScoped).toEqual({ to: '/settings/credentials' });
});

test('does not link a row that lacks the slugs it needs', () => {
	const link = auditEntryLink(
		entry({ entity_type: 'task', entity_identifier: 'OP-1', project_slug: null }),
	);
	expect(link).toBeNull();
});
