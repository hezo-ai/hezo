import { expect, test } from 'vitest';
import type { AuditEntry } from '../src/hooks/use-audit-log';
import { auditEntryLink, describeAuditEntry } from '../src/lib/audit-format';
import de from '../src/lib/i18n/catalog/de.json';

const german = (key: keyof typeof de, vars: Record<string, string | number> = {}): string => {
	let message = de[key];
	for (const [name, value] of Object.entries(vars))
		message = message.replace(`{${name}}`, String(value));
	return message;
};

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

test.each([
	['title', { from: 'Alt', to: 'Neu' }, 'OP-1 von „Alt“ in „Neu“ umbenannt'],
	['description', {}, 'Beschreibung von OP-1 aktualisiert'],
	[
		'status',
		{ from: 'in_progress', to: 'done' },
		'Status von OP-1 von In Arbeit auf Erledigt geändert',
	],
	['priority', { from: 'medium', to: 'high' }, 'Priorität von OP-1 von Mittel auf Hoch geändert'],
	[
		'assignee',
		{ from_label: null, to_label: 'Alice' },
		'OP-1 von Nicht zugewiesen an Alice neu zugewiesen',
	],
	[
		'parent',
		{ from_label: 'OP-4', to_label: null },
		'OP-1 aus OP-4 auf die oberste Ebene verschoben',
	],
])('localizes the %s task update and its enum values', (field, values, expected) => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field, ...values },
	});
	expect(describeAuditEntry(e, german)).toBe(expected);
});

test('uses non-null ids instead of null-state labels when a relation label is unresolved', () => {
	const assignee = entry({
		action: 'updated',
		entity_type: 'task',
		details: {
			field: 'assignee',
			from: 'member-missing',
			to: 'member-alice',
			to_label: 'Alice',
		},
	});
	expect(describeAuditEntry(assignee)).toBe('Reassigned OP-1 from member-missing to Alice');

	const parent = entry({
		action: 'updated',
		entity_type: 'task',
		details: { field: 'parent', from: 'task-missing', to: null },
	});
	expect(describeAuditEntry(parent)).toBe('Moved OP-1 out of task-missing to top level');
});

test.each([
	['priority', { from: 'medium', to: 'high' }, 'Changed priority of OP-1 from Medium to High'],
	['progress_summary', {}, 'Updated the progress summary of OP-1'],
	['rules', {}, 'Updated the rules of OP-1'],
	['branch', { from: null, to: 'hezo/OP-1' }, 'Set branch of OP-1 to hezo/OP-1'],
	['branch', { from: 'hezo/OP-1', to: null }, 'Cleared branch of OP-1 (was hezo/OP-1)'],
	['runtime', { from: null, to: 'codex' }, 'Set runtime of OP-1 to Codex'],
	[
		'runtime',
		{ from: 'codex', to: 'claude_code' },
		'Changed runtime of OP-1 from Codex to Claude Code',
	],
])('describes a %s task update', (field, values, expected) => {
	const e = entry({
		action: 'updated',
		entity_type: 'task',
		entity_identifier: 'OP-1',
		details: { field, ...values },
	});
	expect(describeAuditEntry(e)).toBe(expected);
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
