import { TASK_STATUS_LABELS, type TaskStatus } from '@hezo/shared';
import type { AuditEntry } from '../hooks/use-audit-log';

/** Past-tense verb for an audit action, used to open a description sentence. */
function actionVerb(action: string): string {
	switch (action) {
		case 'created':
			return 'Created';
		case 'updated':
			return 'Updated';
		case 'deleted':
			return 'Deleted';
		case 'run_started':
			return 'Started';
		case 'run_completed':
			return 'Completed';
		case 'requested':
			return 'Requested';
		default:
			return action.charAt(0).toUpperCase() + action.slice(1).replace(/_/g, ' ');
	}
}

function statusLabel(value: string | null | undefined): string {
	if (!value) return 'none';
	return TASK_STATUS_LABELS[value as TaskStatus] ?? value;
}

function str(details: Record<string, unknown>, key: string): string | null {
	const v = details[key];
	return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The task identifier a row concerns, whether it is the entity itself or referenced. */
function taskRef(entry: AuditEntry): string | null {
	return entry.entity_identifier ?? entry.ref_task_identifier;
}

/**
 * One human-readable sentence describing an audit row, naming the subject
 * (task identifier, resource name) and the relevant change. Falls back to a
 * generic "<verb> <entity_type> <name>" so every row still reads sensibly.
 */
export function describeAuditEntry(entry: AuditEntry): string {
	const d = entry.details ?? {};
	const verb = actionVerb(entry.action);
	const task = taskRef(entry);

	switch (entry.entity_type) {
		case 'task': {
			const id = task ?? str(d, 'identifier') ?? 'a task';
			if (entry.action === 'created') return `Created task ${id}`;
			const field = str(d, 'field');
			if (field === 'title') {
				return `Renamed ${id} from "${str(d, 'from') ?? ''}" to "${str(d, 'to') ?? ''}"`;
			}
			// No from/to: the description bodies deliberately never reach the audit
			// row (see TaskUpdateField), so there is nothing to quote here.
			if (field === 'description') return `Updated the description of ${id}`;
			if (field === 'status') {
				return `Changed status of ${id} from ${statusLabel(str(d, 'from'))} to ${statusLabel(str(d, 'to'))}`;
			}
			if (field === 'assignee') {
				const from = str(d, 'from_label') ?? 'Unassigned';
				const to = str(d, 'to_label') ?? 'Unassigned';
				return `Reassigned ${id} from ${from} to ${to}`;
			}
			if (field === 'parent') {
				const from = str(d, 'from_label');
				const to = str(d, 'to_label');
				if (from && to) return `Moved ${id} from ${from} to ${to}`;
				if (to) return `Moved ${id} under ${to}`;
				if (from) return `Moved ${id} out of ${from} to top level`;
				return `Moved ${id} to top level`;
			}
			return `${verb} task ${id}`;
		}
		case 'project':
			return `${verb} project ${str(d, 'name') ?? str(d, 'slug') ?? ''}`.trimEnd();
		case 'agent_run': {
			const on = task ? ` on ${task}` : '';
			const outcome = str(d, 'status') ? ` (${str(d, 'status')})` : '';
			if (entry.action === 'run_started') return `Started an agent run${on}`;
			if (entry.action === 'run_completed') return `Completed an agent run${on}${outcome}`;
			return `${verb} an agent run${on}`;
		}
		case 'asset':
			return `Uploaded ${str(d, 'filename') ?? 'a file'}${task ? ` to ${task}` : ''}`;
		case 'document':
			if (str(d, 'field') === 'system_prompt') return `${verb} the system prompt`;
			return `${verb} document ${str(d, 'title') ?? str(d, 'slug') ?? ''}`.trimEnd();
		case 'agent': {
			if (entry.action === 'created') return 'Created an agent';
			const change = str(d, 'change');
			if (change === 'disabled') return 'Disabled an agent';
			if (change === 'enabled') return 'Enabled an agent';
			if (str(d, 'field') === 'system_prompt') return 'Updated an agent’s system prompt';
			return 'Updated an agent';
		}
		case 'secret':
			if (entry.action === 'requested') {
				return `Requested credential ${str(d, 'name') ?? ''}${task ? ` for ${task}` : ''}`.trimEnd();
			}
			return `${verb} secret ${str(d, 'name') ?? ''}`.trimEnd();
		case 'connection':
			return `${verb} ${str(d, 'provider') ?? ''} connection`.replace('  ', ' ').trimEnd();
		case 'mcp_connection':
			return `${verb} MCP connection ${str(d, 'name') ?? ''}`.trimEnd();
		case 'skill':
			return `${verb} skill ${str(d, 'name') ?? str(d, 'slug') ?? ''}`.trimEnd();
		default: {
			const name = str(d, 'name') ?? str(d, 'slug') ?? str(d, 'identifier');
			return `${verb} ${entry.entity_type.replace(/_/g, ' ')}${name ? ` ${name}` : ''}`;
		}
	}
}

export type AuditLink =
	| { to: '/projects/$projectId/tasks/$taskId'; params: Record<string, string> }
	| { to: '/projects/$projectId'; params: Record<string, string> }
	| { to: '/projects/$projectId/connectors'; params: Record<string, string> }
	| { to: '/projects/$projectId/agents'; params: Record<string, string> }
	| { to: '/settings/credentials' }
	| { to: '/settings/connectors' }
	| { to: '/settings/skills' };

/**
 * The navigation target for an audit row, or null when the row has no resource
 * page (or lacks the slugs needed to build one). Project-scoped rows (incl. agent
 * and per-project connector rows) deep-link into the owning project. Instance-global
 * config (secrets, skills, and connectors/agents with no project) falls back to the
 * Admin pages.
 */
export function auditEntryLink(entry: AuditEntry): AuditLink | null {
	const project = entry.project_slug;
	const task = entry.entity_identifier ?? entry.ref_task_identifier;

	switch (entry.entity_type) {
		case 'task':
		case 'agent_run':
		case 'asset':
			if (project && task) {
				return {
					to: '/projects/$projectId/tasks/$taskId',
					params: { projectId: project, taskId: task.toLowerCase() },
				};
			}
			return null;
		case 'project':
			return project ? { to: '/projects/$projectId', params: { projectId: project } } : null;
		case 'secret':
			// Credentials are instance-global — always the Admin page.
			return { to: '/settings/credentials' };
		case 'connection':
		case 'mcp_connection':
			return project
				? { to: '/projects/$projectId/connectors', params: { projectId: project } }
				: { to: '/settings/connectors' };
		case 'skill':
			// Skills are instance-global — always the Admin page.
			return { to: '/settings/skills' };
		case 'agent':
			return project ? { to: '/projects/$projectId/agents', params: { projectId: project } } : null;
		default:
			return null;
	}
}
