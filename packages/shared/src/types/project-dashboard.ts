import type { GoalHealth, ProjectProgress } from './common.js';

export const DASHBOARD_WIDGET_IDS = ['goals', 'team_snapshot', 'in_progress', 'spend'] as const;

export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];
export type DashboardWidgetOrder = DashboardWidgetId[];

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

export interface ProjectDashboardMention {
	id: string;
	task_id: string;
	task_identifier: string;
	task_title: string;
	comment_public_id: string;
	snippet: string;
	author_display_name: string;
	created_at: string;
}

/**
 * One dashboard action item. The kinds here are exactly what the inbox renders,
 * so the widget's "Open inbox" link lands on the same rows it just listed.
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
