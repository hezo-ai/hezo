import type { CommentContentType, GoalHealth, ProjectProgress } from './common.js';

/**
 * Rows the dashboard's capped lists render before deferring to their full page.
 *
 * The two numbers are chosen together, not independently: the in-progress list is the left
 * column's floor and the goals card is the right column's, so they are what makes the two
 * columns bottom out level. Changing one without the other unbalances the grid.
 */
export const DASHBOARD_IN_PROGRESS_LIMIT = 7;
/**
 * Slots in the goals card. With more goals than this the last slot becomes a "+N more" link,
 * so the card's height is the same whether a project has four goals or forty.
 */
export const DASHBOARD_GOAL_SLOTS = 4;

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
	/** One line of the comment body, Markdown stripped - render it as plain text. */
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
}
