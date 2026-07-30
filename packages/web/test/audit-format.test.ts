import { expect, test } from 'vitest';
import type { AuditEntry } from '../src/hooks/use-audit-log';
import { auditEntryLink, describeAuditEntry } from '../src/lib/audit-format';

function entry(overrides: Partial<AuditEntry>): AuditEntry {
	return {
		id: 'a1',
		project_id: 'p1',
		actor_type: 'admin',
		actor_member_id: null,
		actor_api_key_id: null,
		actor_name: 'Alice',
		project_slug: 'ops',
		project_name: 'Ops',
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

test('describes a description edit without quoting either body', () => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'description', from: null, to: null },
	});
	expect(describeAuditEntry(e)).toBe('Updated the description of OP-1');
});

test('describes a reassignment with resolved names', () => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'assignee', from_label: 'Bob', to_label: 'Alice' },
	});
	expect(describeAuditEntry(e)).toBe('Reassigned OP-1 from Bob to Alice');
});

test('describes a move between two parents', () => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'parent', from_label: 'OP-4', to_label: 'OP-9' },
	});
	expect(describeAuditEntry(e)).toBe('Moved OP-1 from OP-4 to OP-9');
});

test('describes a promotion to top level', () => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'parent', from_label: 'OP-4', to_label: null },
	});
	expect(describeAuditEntry(e)).toBe('Moved OP-1 out of OP-4 to top level');
});

test('describes a first nesting', () => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'parent', from_label: null, to_label: 'OP-9' },
	});
	expect(describeAuditEntry(e)).toBe('Moved OP-1 under OP-9');
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
		entity_type: 'team',
		entity_identifier: null,
		details: {},
	});
	expect(describeAuditEntry(e)).toBe('Created team');
});

test('links a task row to the task route with a lowercased identifier', () => {
	const link = auditEntryLink(entry({ entity_type: 'task', entity_identifier: 'OP-1' }));
	expect(link).toEqual({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: 'ops', taskId: 'op-1' },
	});
});

test('a secret row always links to the global Admin credentials page', () => {
	// Credentials are instance-global, so every secret audit row anchors on the
	// Admin page regardless of which project the run belonged to.
	const projectContext = auditEntryLink(
		entry({ entity_type: 'secret', entity_identifier: null, project_slug: 'ops' }),
	);
	expect(projectContext).toEqual({ to: '/settings/credentials' });

	const noContext = auditEntryLink(
		entry({
			entity_type: 'secret',
			entity_identifier: null,
			project_id: null,
			project_slug: null,
		}),
	);
	expect(noContext).toEqual({ to: '/settings/credentials' });
});

test('a connection row links into its project, or the Admin page when instance-scoped', () => {
	const projectScoped = auditEntryLink(
		entry({ entity_type: 'connection', entity_identifier: null, project_slug: 'ops' }),
	);
	expect(projectScoped).toEqual({
		to: '/projects/$projectId/connectors',
		params: { projectId: 'ops' },
	});

	const instanceScoped = auditEntryLink(
		entry({
			entity_type: 'connection',
			entity_identifier: null,
			project_id: null,
			project_slug: null,
		}),
	);
	expect(instanceScoped).toEqual({ to: '/settings/connectors' });
});

test('does not link a row that lacks the slugs it needs', () => {
	const link = auditEntryLink(
		entry({ entity_type: 'task', entity_identifier: 'OP-1', project_slug: null }),
	);
	expect(link).toBeNull();
});
