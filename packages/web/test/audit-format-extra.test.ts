import { describe, expect, test } from 'vitest';
import type { AuditEntry } from '../src/hooks/use-audit-log';
import { auditEntryLink, describeAuditEntry } from '../src/lib/audit-format';

// Covers the branches not exercised by audit-format.test.ts: the default action
// verb, project/document/agent/skill/mcp_connection descriptions, the agent_run
// completed + outcome path, and the asset/agent/connection link targets.
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

describe('describeAuditEntry — action verbs', () => {
	test('maps each known action to its past-tense verb on a generic entity', () => {
		const cases: Array<[string, string]> = [
			['updated', 'Updated'],
			['deleted', 'Deleted'],
		];
		for (const [action, verb] of cases) {
			const e = entry({ entity_type: 'project', action, details: { name: 'Ops' } });
			expect(describeAuditEntry(e)).toBe(`${verb} project Ops`);
		}
	});

	test('an unknown action is title-cased with underscores turned to spaces', () => {
		const e = entry({
			entity_type: 'project',
			action: 'force_synced',
			details: { name: 'Ops' },
		});
		expect(describeAuditEntry(e)).toBe('Force synced project Ops');
	});
});

describe('describeAuditEntry — task fallbacks', () => {
	test('a task update with no recognised field falls back to "<verb> task <id>"', () => {
		const e = entry({ action: 'updated', entity_type: 'task', details: {} });
		expect(describeAuditEntry(e)).toBe('Updated task OP-1');
	});

	test('a task with no identifier anywhere reads "a task"', () => {
		const e = entry({
			action: 'updated',
			entity_type: 'task',
			entity_identifier: null,
			ref_task_identifier: null,
			details: {},
		});
		expect(describeAuditEntry(e)).toBe('Updated task a task');
	});

	test('status change with absent from/to reads "none"', () => {
		const e = entry({
			action: 'updated',
			entity_type: 'task',
			details: { field: 'status' },
		});
		expect(describeAuditEntry(e)).toBe('Changed status of OP-1 from none to none');
	});

	test('reassignment without labels defaults to Unassigned', () => {
		const e = entry({
			action: 'updated',
			entity_type: 'task',
			details: { field: 'assignee' },
		});
		expect(describeAuditEntry(e)).toBe('Reassigned OP-1 from Unassigned to Unassigned');
	});
});

describe('describeAuditEntry — project', () => {
	test('uses slug when name is absent', () => {
		const e = entry({ entity_type: 'project', details: { slug: 'ops' } });
		expect(describeAuditEntry(e)).toBe('Created project ops');
	});

	test('trims trailing space when neither name nor slug is present', () => {
		const e = entry({ entity_type: 'project', details: {} });
		expect(describeAuditEntry(e)).toBe('Created project');
	});
});

describe('describeAuditEntry — agent_run', () => {
	test('completed run with outcome appends the status in parens', () => {
		const e = entry({
			action: 'run_completed',
			entity_type: 'agent_run',
			entity_identifier: null,
			ref_task_identifier: 'OP-2',
			details: { status: 'succeeded' },
		});
		expect(describeAuditEntry(e)).toBe('Completed an agent run on OP-2 (succeeded)');
	});

	test('completed run with no task and no outcome', () => {
		const e = entry({
			action: 'run_completed',
			entity_type: 'agent_run',
			entity_identifier: null,
			ref_task_identifier: null,
			details: {},
		});
		expect(describeAuditEntry(e)).toBe('Completed an agent run');
	});

	test('other agent_run action uses the generic verb', () => {
		const e = entry({
			action: 'cancelled',
			entity_type: 'agent_run',
			entity_identifier: null,
			ref_task_identifier: 'OP-3',
			details: {},
		});
		expect(describeAuditEntry(e)).toBe('Cancelled an agent run on OP-3');
	});
});

describe('describeAuditEntry — asset / document / agent / connection / mcp / skill', () => {
	test('asset names the file and the task it was attached to', () => {
		const e = entry({
			entity_type: 'asset',
			entity_identifier: null,
			ref_task_identifier: 'OP-4',
			details: { filename: 'logo.png' },
		});
		expect(describeAuditEntry(e)).toBe('Uploaded logo.png to OP-4');
	});

	test('asset without filename or task falls back to "a file"', () => {
		const e = entry({
			entity_type: 'asset',
			entity_identifier: null,
			ref_task_identifier: null,
			details: {},
		});
		expect(describeAuditEntry(e)).toBe('Uploaded a file');
	});

	test('document system_prompt field has a dedicated sentence', () => {
		const e = entry({
			entity_type: 'document',
			action: 'updated',
			details: { field: 'system_prompt' },
		});
		expect(describeAuditEntry(e)).toBe('Updated the system prompt');
	});

	test('document uses title, then slug, then nothing', () => {
		expect(describeAuditEntry(entry({ entity_type: 'document', details: { title: 'Spec' } }))).toBe(
			'Created document Spec',
		);
		expect(describeAuditEntry(entry({ entity_type: 'document', details: { slug: 'spec' } }))).toBe(
			'Created document spec',
		);
		expect(describeAuditEntry(entry({ entity_type: 'document', details: {} }))).toBe(
			'Created document',
		);
	});

	test('agent created/enabled/disabled/system_prompt/default', () => {
		expect(describeAuditEntry(entry({ entity_type: 'agent', action: 'created' }))).toBe(
			'Created an agent',
		);
		expect(
			describeAuditEntry(
				entry({ entity_type: 'agent', action: 'updated', details: { change: 'disabled' } }),
			),
		).toBe('Disabled an agent');
		expect(
			describeAuditEntry(
				entry({ entity_type: 'agent', action: 'updated', details: { change: 'enabled' } }),
			),
		).toBe('Enabled an agent');
		expect(
			describeAuditEntry(
				entry({ entity_type: 'agent', action: 'updated', details: { field: 'system_prompt' } }),
			),
		).toBe('Updated an agent’s system prompt');
		expect(
			describeAuditEntry(entry({ entity_type: 'agent', action: 'updated', details: {} })),
		).toBe('Updated an agent');
	});

	test('secret requested names the credential and task', () => {
		const e = entry({
			entity_type: 'secret',
			action: 'requested',
			entity_identifier: null,
			ref_task_identifier: 'OP-5',
			details: { name: 'STRIPE_KEY' },
		});
		expect(describeAuditEntry(e)).toBe('Requested credential STRIPE_KEY for OP-5');
	});

	test('connection collapses the double space when provider is absent', () => {
		const e = entry({ entity_type: 'connection', details: {} });
		expect(describeAuditEntry(e)).toBe('Created connection');
	});

	test('connection with provider', () => {
		const e = entry({ entity_type: 'connection', details: { provider: 'github' } });
		expect(describeAuditEntry(e)).toBe('Created github connection');
	});

	test('mcp_connection with and without a name', () => {
		expect(
			describeAuditEntry(entry({ entity_type: 'mcp_connection', details: { name: 'Linear' } })),
		).toBe('Created MCP connection Linear');
		expect(describeAuditEntry(entry({ entity_type: 'mcp_connection', details: {} }))).toBe(
			'Created MCP connection',
		);
	});

	test('skill uses name, then slug', () => {
		expect(describeAuditEntry(entry({ entity_type: 'skill', details: { name: 'Deploy' } }))).toBe(
			'Created skill Deploy',
		);
		expect(describeAuditEntry(entry({ entity_type: 'skill', details: { slug: 'deploy' } }))).toBe(
			'Created skill deploy',
		);
	});

	test('generic fallback names the entity and any available identifier', () => {
		const withName = entry({
			entity_type: 'webhook_endpoint',
			entity_identifier: null,
			details: { identifier: 'WH-9' },
		});
		expect(describeAuditEntry(withName)).toBe('Created webhook endpoint WH-9');
	});
});

describe('auditEntryLink — remaining targets', () => {
	test('an asset row links to its task', () => {
		const link = auditEntryLink(
			entry({ entity_type: 'asset', entity_identifier: null, ref_task_identifier: 'OP-7' }),
		);
		expect(link).toEqual({
			to: '/projects/$projectId/tasks/$taskId',
			params: { projectId: 'ops', taskId: 'op-7' },
		});
	});

	test('an agent_run row without slugs does not link', () => {
		const link = auditEntryLink(
			entry({ entity_type: 'agent_run', entity_identifier: null, ref_task_identifier: null }),
		);
		expect(link).toBeNull();
	});

	test('a project row links to the project, or null without a slug', () => {
		expect(auditEntryLink(entry({ entity_type: 'project' }))).toEqual({
			to: '/projects/$projectId',
			params: { projectId: 'ops' },
		});
		expect(auditEntryLink(entry({ entity_type: 'project', project_slug: null }))).toBeNull();
	});

	test('an mcp_connection links into its project or the Admin page', () => {
		expect(auditEntryLink(entry({ entity_type: 'mcp_connection' }))).toEqual({
			to: '/projects/$projectId/connectors',
			params: { projectId: 'ops' },
		});
		expect(auditEntryLink(entry({ entity_type: 'mcp_connection', project_slug: null }))).toEqual({
			to: '/settings/connectors',
		});
	});

	test('a skill row always links to the global Admin skills page', () => {
		expect(auditEntryLink(entry({ entity_type: 'skill', project_slug: null }))).toEqual({
			to: '/settings/skills',
		});
	});

	test('an agent row links into its project, or null when instance-scoped', () => {
		expect(auditEntryLink(entry({ entity_type: 'agent' }))).toEqual({
			to: '/projects/$projectId/agents',
			params: { projectId: 'ops' },
		});
		expect(auditEntryLink(entry({ entity_type: 'agent', project_slug: null }))).toBeNull();
	});

	test('an unmapped entity type does not link', () => {
		expect(auditEntryLink(entry({ entity_type: 'team' }))).toBeNull();
	});
});

// Archive/restore rows share the `updated` action with a content edit, so the
// sentence has to come from `details.archived`. Before this, every asset row
// read "Uploaded ..." — including archives, deletes and deletion requests.
describe('describeAuditEntry — archive lifecycle', () => {
	test('names an asset archive and restore instead of calling them uploads', () => {
		const archived = entry({
			entity_type: 'asset',
			action: 'updated',
			entity_identifier: null,
			details: { filename: 'reports/q3.html', archived: true },
		});
		expect(describeAuditEntry(archived)).toBe('Archived reports/q3.html');

		const restored = entry({
			entity_type: 'asset',
			action: 'updated',
			entity_identifier: null,
			details: { filename: 'reports/q3.html', archived: false },
		});
		expect(describeAuditEntry(restored)).toBe('Restored reports/q3.html');
	});

	test('still describes a plain upload as an upload', () => {
		const uploaded = entry({
			entity_type: 'asset',
			action: 'created',
			entity_identifier: null,
			ref_task_identifier: 'OP-7',
			details: { filename: 'hero.png' },
		});
		expect(describeAuditEntry(uploaded)).toBe('Uploaded hero.png to OP-7');
	});

	test('reads the plural filenames key on deletes and deletion requests', () => {
		const deleted = entry({
			entity_type: 'asset',
			action: 'deleted',
			entity_identifier: null,
			details: { filenames: ['old.png', 'older.png'] },
		});
		expect(describeAuditEntry(deleted)).toBe('Deleted old.png, older.png');

		const requested = entry({
			entity_type: 'asset',
			action: 'requested',
			entity_identifier: null,
			ref_task_identifier: 'OP-9',
			details: { filenames: ['old.png'] },
		});
		expect(describeAuditEntry(requested)).toBe('Requested deletion of old.png in OP-9');
	});

	test('distinguishes a doc archive/restore from a content edit', () => {
		const archived = entry({
			entity_type: 'document',
			action: 'updated',
			entity_identifier: null,
			details: { slug: 'spec.md', title: 'Spec', archived: true },
		});
		expect(describeAuditEntry(archived)).toBe('Archived document Spec');

		const restored = entry({
			entity_type: 'document',
			action: 'updated',
			entity_identifier: null,
			details: { slug: 'spec.md', title: 'Spec', archived: false },
		});
		expect(describeAuditEntry(restored)).toBe('Restored document Spec');

		const edited = entry({
			entity_type: 'document',
			action: 'updated',
			entity_identifier: null,
			details: { slug: 'spec.md', title: 'Spec' },
		});
		expect(describeAuditEntry(edited)).toBe('Updated document Spec');
	});
});
