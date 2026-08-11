import type { CommentContentType, GoalHealth, ProjectProgress } from './common.js';

export const DASHBOARD_WIDGET_IDS = ['goals', 'team_snapshot', 'in_progress', 'spend'] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];
export type DashboardWidgetOrder = DashboardWidgetId[];

/**
 * Default widget render order, in descending order of how often an operator
 * acts on it. Status and the action items sit above the grid, so this list
 * continues from there: the work in flight, then who is on it, then the
 * longer-horizon readouts.
 *
 * A project that has never been reordered renders in this order; a saved order
 * is a deliberate choice and is returned untouched.
 */
export const DEFAULT_WIDGET_ORDER: DashboardWidgetOrder = [
	'in_progress',
	'team_snapshot',
	'goals',
	'spend',
];

/** Sanitise a stored order: drop unknown ids, append any missing ones at the end. */
export function sanitizeWidgetOrder(raw: unknown): DashboardWidgetOrder {
	const known = new Set(DASHBOARD_WIDGET_IDS as readonly string[]);
	const valid: DashboardWidgetId[] = [];
	const seen = new Set<string>();
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (typeof item === 'string' && known.has(item) && !seen.has(item)) {
				valid.push(item as DashboardWidgetId);
				seen.add(item);
			}
		}
	}
	// Append any widget ids that are missing from the stored order.
	for (const id of DEFAULT_WIDGET_ORDER) {
		if (!seen.has(id)) valid.push(id);
	}
	return valid;
}

/** All-time spend for a project (windowed spend lives on `budget.*.spentCents`). */
export interface ProjectDashboardSpend {
	all_time_cents: number;
}

export interface ProjectDashboardWindowStatus {
	spentCents: number;
	limitCents: number;
	overBudget: boolean;
}

export interface ProjectDashboardBudgetStatus {
	daily: ProjectDashboardWindowStatus;
	weekly: ProjectDashboardWindowStatus;
	monthly: ProjectDashboardWindowStatus;
	overBudget: boolean;
}

/** Compact task row for the dashboard in-progress list. */
export interface ProjectDashboardTask {
	id: string;
	identifier: string;
	title: string;
	status: string;
	assignee_name: string | null;
	assignee_slug: string | null;
	has_active_run: boolean;
	queued_wakeup: {
		reason: 'task_busy' | 'project_at_capacity' | 'agent_running';
		since: string;
		blocker_task_id: string | null;
		blocker_identifier: string | null;
		blocker_project_slug: string | null;
	} | null;
}

/** Compact goal row for the dashboard goals preview. */
export interface ProjectDashboardGoal {
	id: string;
	title: string;
	progress_percent: number;
	health: GoalHealth;
}

export interface ProjectDashboardApproval {
	id: string;
	type: string;
	created_at: string;
	requested_by_name: string | null;
	payload_task_identifier: string | null;
}

/** An unread admin-inbox row; `content_type` says what is being asked for. */
export interface ProjectDashboardMention {
	id: string;
	task_id: string;
	task_identifier: string;
	task_title: string;
	comment_public_id: string;
	content_type: CommentContentType;
	credential_name: string | null;
	snippet: string;
	author_display_name: string;
	created_at: string;
}

/**
 * One dashboard action item. These are exactly the project inbox's *unread*
 * rows, so the widget's "Open inbox" link lands on what it just listed, and an
 * item leaves the dashboard when the admin reads it - it stays in the inbox.
 */
export type ProjectDashboardNeedsYouItem =
	| { kind: 'approval'; created_at: string; approval: ProjectDashboardApproval }
	| { kind: 'mention'; created_at: string; mention: ProjectDashboardMention };

/** A team agent currently running, with its active task when known. */
export interface ProjectDashboardRunningAgent {
	id: string;
	slug: string;
	title: string;
	icon_url: string | null;
	task_id: string | null;
	task_identifier: string | null;
	/** False when the active run's task belongs to another project (e.g. HQ agent on a team task). */
	task_in_current_project: boolean;
	run_status: 'running' | 'queued' | null;
}

/** Aggregated at-a-glance payload for the per-project Dashboard page. */
export interface ProjectDashboard {
	is_internal: boolean;
	open_task_count: number;
	running_agents_count: number;
	running_agents: ProjectDashboardRunningAgent[];
	last_activity_at: string;
	container_status: 'creating' | 'running' | 'stopping' | 'stopped' | 'error' | null;
	spend: ProjectDashboardSpend;
	budget: ProjectDashboardBudgetStatus | null;
	progress: ProjectProgress | null;
	goals: ProjectDashboardGoal[];
	in_progress_tasks: ProjectDashboardTask[];
	needs_you: ProjectDashboardNeedsYouItem[];
	action_count: number;
	widget_order: DashboardWidgetOrder;
}
