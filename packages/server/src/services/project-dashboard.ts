import {
	ApprovalStatus,
	ApprovalType,
	type ProjectDashboard,
	type ProjectDashboardBudgetStatus,
	type ProjectDashboardNeedsYouItem,
	TaskStatus,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { terminalStatusParams } from '../lib/sql';
import { taskActiveRunExistsSql } from '../lib/task-sort';
import {
	type BudgetLimits,
	type EntityBudgetStatus,
	getProjectSpend,
	toEntityBudgetStatus,
} from './budget';
import { getProjectProgress } from './projects';

const IN_PROGRESS_STATUSES = [TaskStatus.InProgress, TaskStatus.Review];
const NEEDS_YOU_LIMIT = 10;
const IN_PROGRESS_LIMIT = 10;
const GOALS_PREVIEW_LIMIT = 3;

function mapBudget(status: EntityBudgetStatus): ProjectDashboardBudgetStatus {
	return {
		daily: status.daily,
		weekly: status.weekly,
		monthly: status.monthly,
		overBudget: status.overBudget,
	};
}

function buildSnippet(content: unknown): string {
	if (!content || typeof content !== 'object') return '';
	const text = (content as Record<string, unknown>).text;
	if (typeof text !== 'string') return '';
	const stripped = text.replace(/\s+/g, ' ').trim();
	if (stripped.length <= 180) return stripped;
	return `${stripped.slice(0, 179).trimEnd()}…`;
}

async function getProjectMeta(
	db: Db,
	projectId: string,
	teamId: string,
): Promise<{
	is_internal: boolean;
	open_task_count: number;
	last_activity_at: string;
	container_status: ProjectDashboard['container_status'];
} | null> {
	const ts = terminalStatusParams(1);
	const result = await db.query<{
		is_internal: boolean;
		open_task_count: number;
		last_activity_at: string;
		container_status: ProjectDashboard['container_status'];
	}>(
		`SELECT p.is_internal,
		        (SELECT count(*) FROM tasks i WHERE i.project_id = p.id AND i.status NOT IN (${ts.placeholders}))::int AS open_task_count,
		        COALESCE((SELECT max(i3.updated_at) FROM tasks i3 WHERE i3.project_id = p.id), p.created_at)
		           AS last_activity_at,
		        p.container_status
		 FROM projects p
		 WHERE p.id = $${ts.values.length + 1} AND p.team_id = $${ts.values.length + 2}`,
		[...ts.values, projectId, teamId],
	);
	return result.rows[0] ?? null;
}

async function getProjectSpendBundle(
	db: Db,
	projectId: string,
): Promise<{
	all_time_cents: number;
	budget: ProjectDashboardBudgetStatus;
}> {
	const [spend, limitsRes] = await Promise.all([
		getProjectSpend(db, projectId),
		db.query<BudgetLimits>(
			`SELECT daily_budget_cents, weekly_budget_cents, monthly_budget_cents
			 FROM projects WHERE id = $1`,
			[projectId],
		),
	]);
	const limits = limitsRes.rows[0] ?? {
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 0,
	};
	return {
		all_time_cents: spend.allTime,
		budget: mapBudget(toEntityBudgetStatus(spend, limits)),
	};
}

async function getGoalsPreview(db: Db, projectId: string) {
	const result = await db.query<{
		id: string;
		title: string;
		progress_percent: number;
		health: string;
	}>(
		`SELECT id, title, progress_percent, health
		 FROM goals
		 WHERE project_id = $1 AND archived_at IS NULL
		 ORDER BY
		   CASE health
		     WHEN 'off_track' THEN 0
		     WHEN 'at_risk' THEN 1
		     WHEN 'pending' THEN 2
		     WHEN 'on_track' THEN 3
		     ELSE 4
		   END,
		   updated_at DESC
		 LIMIT $2`,
		[projectId, GOALS_PREVIEW_LIMIT],
	);
	return result.rows;
}

async function getInProgressTasks(db: Db, projectId: string) {
	const statuses = IN_PROGRESS_STATUSES.map((_, i) => `$${i + 2}::task_status`).join(', ');
	const activeRunSql = taskActiveRunExistsSql('i');
	const result = await db.query(
		`SELECT i.id, i.identifier, i.title, i.status,
		        COALESCE(ma.title, m.display_name) AS assignee_name,
		        ma.slug AS assignee_slug,
		        ${activeRunSql} AS has_active_run,
		        CASE WHEN qw.last_skipped_reason IS NOT NULL THEN json_build_object(
		          'reason', qw.last_skipped_reason,
		          'since', qw.last_skipped_at,
		          'blocker_task_id', qw.last_skipped_blocker_task_id,
		          'blocker_identifier', qw.blocker_identifier,
		          'blocker_project_slug', qw.blocker_project_slug
		        ) ELSE NULL END AS queued_wakeup
		 FROM tasks i
		 LEFT JOIN members m ON m.id = i.assignee_id
		 LEFT JOIN member_agents ma ON ma.id = i.assignee_id
		 LEFT JOIN LATERAL (
		   SELECT w.last_skipped_reason, w.last_skipped_at, w.last_skipped_blocker_task_id,
		          b.identifier AS blocker_identifier,
		          bp.slug AS blocker_project_slug
		   FROM agent_wakeup_requests w
		   LEFT JOIN tasks b ON b.id = w.last_skipped_blocker_task_id
		   LEFT JOIN projects bp ON bp.id = b.project_id
		   WHERE w.member_id = i.assignee_id
		     AND w.payload->>'task_id' = i.id::text
		     AND w.status = 'queued'
		     AND w.last_skipped_at IS NOT NULL
		   ORDER BY w.last_skipped_at DESC
		   LIMIT 1
		 ) qw ON true
		 WHERE i.project_id = $1 AND i.status IN (${statuses})
		 ORDER BY ${activeRunSql} DESC, i.updated_at DESC
		 LIMIT $${IN_PROGRESS_STATUSES.length + 2}`,
		[projectId, ...IN_PROGRESS_STATUSES, IN_PROGRESS_LIMIT],
	);
	return result.rows as unknown as ProjectDashboard['in_progress_tasks'];
}

async function getNeedsYou(
	db: Db,
	teamId: string,
	projectId: string,
	adminUserId: string,
): Promise<{ items: ProjectDashboardNeedsYouItem[]; inbox_unread: number }> {
	const [approvals, mentions, credentials, countRow] = await Promise.all([
		db.query<{
			id: string;
			type: string;
			created_at: string;
			requested_by_name: string | null;
			payload_task_identifier: string | null;
		}>(
			`SELECT a.id, a.type, a.created_at,
			        COALESCE(ma.title, m.display_name) AS requested_by_name,
			        pi.identifier AS payload_task_identifier
			 FROM approvals a
			 LEFT JOIN members m ON m.id = a.requested_by_member_id
			 LEFT JOIN member_agents ma ON ma.id = a.requested_by_member_id
			 LEFT JOIN tasks pi ON pi.id = (a.payload->>'task_id')::uuid
			 WHERE a.team_id = $1
			   AND a.status = $2::approval_status
			   AND a.archived_at IS NULL
			   AND (
			     -- Project-linked approvals (plan review, repo setup, …)
			     (a.payload->>'project_id')::uuid = $3
			     OR pi.project_id = $3
			     -- Team-scoped approvals with no project/task pointer (hire, …).
			     -- Project↔team is 1:1, so team_id already scopes these correctly.
			     OR (
			       a.payload->>'project_id' IS NULL
			       AND a.payload->>'task_id' IS NULL
			     )
			     -- Hire is always team-scoped. A payload task_id may be deleted;
			     -- still surface the pending hire on this project's dashboard.
			     OR a.type = $5::approval_type
			   )
			 ORDER BY a.created_at DESC
			 LIMIT $4`,
			[teamId, ApprovalStatus.Pending, projectId, NEEDS_YOU_LIMIT, ApprovalType.Hire],
		),
		db.query<{
			id: string;
			task_id: string;
			task_identifier: string;
			task_title: string;
			comment_public_id: string;
			content: unknown;
			author_display_name: string | null;
			created_at: string;
		}>(
			`SELECT bm.id, bm.task_id, i.identifier AS task_identifier, i.title AS task_title,
			        tc.public_id AS comment_public_id, tc.content,
			        COALESCE(ma.title, m.display_name) AS author_display_name,
			        bm.created_at
			 FROM admin_mentions bm
			 JOIN tasks i ON i.id = bm.task_id
			 JOIN task_comments tc ON tc.id = bm.comment_id
			 LEFT JOIN members m ON m.id = tc.author_member_id
			 LEFT JOIN member_agents ma ON ma.id = tc.author_member_id
			 WHERE bm.team_id = $1 AND bm.user_id = $2
			   AND i.project_id = $3
			   AND bm.read_at IS NULL AND bm.archived_at IS NULL
			 ORDER BY bm.created_at DESC
			 LIMIT $4`,
			[teamId, adminUserId, projectId, NEEDS_YOU_LIMIT],
		),
		db.query<{
			comment_id: string;
			comment_public_id: string;
			task_id: string;
			task_identifier: string;
			task_title: string;
			credential_name: string;
			created_at: string;
		}>(
			`SELECT tc.id AS comment_id, tc.public_id AS comment_public_id,
			        i.id AS task_id, i.identifier AS task_identifier, i.title AS task_title,
			        COALESCE(tc.content->>'name', 'credential') AS credential_name,
			        tc.created_at
			 FROM task_comments tc
			 JOIN tasks i ON i.id = tc.task_id
			 WHERE i.project_id = $1
			   AND tc.content_type = 'credential_request'::comment_content_type
			   AND tc.chosen_option IS NULL
			 ORDER BY tc.created_at DESC
			 LIMIT $2`,
			[projectId, NEEDS_YOU_LIMIT],
		),
		db.query<{ unread: number }>(
			`SELECT (
			          (SELECT count(*) FROM admin_mentions bm
			           JOIN tasks i ON i.id = bm.task_id
			           WHERE bm.team_id = $1 AND bm.user_id = $2
			             AND i.project_id = $3
			             AND bm.read_at IS NULL AND bm.archived_at IS NULL)
			        + (SELECT count(*) FROM approvals a
			           LEFT JOIN tasks pi ON pi.id = (a.payload->>'task_id')::uuid
			           WHERE a.team_id = $1
			             AND a.status = $4::approval_status
			             AND a.archived_at IS NULL
			             AND (
			               (a.payload->>'project_id')::uuid = $3
			               OR pi.project_id = $3
			               OR (
			                 a.payload->>'project_id' IS NULL
			                 AND a.payload->>'task_id' IS NULL
			               )
			               OR a.type = $5::approval_type
			             ))
			        + (SELECT count(*) FROM task_comments tc
			           JOIN tasks i ON i.id = tc.task_id
			           WHERE i.project_id = $3
			             AND tc.content_type = 'credential_request'::comment_content_type
			             AND tc.chosen_option IS NULL)
			        )::int AS unread`,
			[teamId, adminUserId, projectId, ApprovalStatus.Pending, ApprovalType.Hire],
		),
	]);

	const items: ProjectDashboardNeedsYouItem[] = [
		...approvals.rows.map((a) => ({
			kind: 'approval' as const,
			created_at: a.created_at,
			approval: {
				id: a.id,
				type: a.type,
				created_at: a.created_at,
				requested_by_name: a.requested_by_name,
				payload_task_identifier: a.payload_task_identifier,
			},
		})),
		...mentions.rows.map((m) => ({
			kind: 'mention' as const,
			created_at: m.created_at,
			mention: {
				id: m.id,
				task_id: m.task_id,
				task_identifier: m.task_identifier,
				task_title: m.task_title,
				comment_public_id: m.comment_public_id,
				snippet: buildSnippet(m.content),
				author_display_name: m.author_display_name ?? 'Agent',
				created_at: m.created_at,
			},
		})),
		...credentials.rows.map((c) => ({
			kind: 'credential' as const,
			created_at: c.created_at,
			credential: c,
		})),
	]
		.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
		.slice(0, NEEDS_YOU_LIMIT);

	return { items, inbox_unread: countRow.rows[0]?.unread ?? 0 };
}

interface RunningAgentRow {
	id: string;
	slug: string;
	title: string;
	icon_updated_at: string | null;
	task_id: string | null;
	task_identifier: string | null;
	task_project_id: string | null;
	run_status: 'running' | 'queued' | null;
}

async function getRunningAgents(db: Db, teamId: string): Promise<RunningAgentRow[]> {
	const result = await db.query<RunningAgentRow>(
		`SELECT ma.id, ma.slug, ma.title,
		        (SELECT ai.updated_at FROM agent_icons ai WHERE ai.member_id = ma.id) AS icon_updated_at,
		        i.id AS task_id,
		        i.identifier AS task_identifier,
		        i.project_id AS task_project_id,
		        hr.run_status
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 LEFT JOIN LATERAL (
		   SELECT hr.task_id, hr.status AS run_status
		   FROM heartbeat_runs hr
		   WHERE hr.member_id = ma.id AND hr.status IN ('running', 'queued')
		   ORDER BY CASE hr.status WHEN 'running' THEN 0 ELSE 1 END,
		            hr.started_at DESC NULLS LAST,
		            hr.created_at DESC
		   LIMIT 1
		 ) hr ON true
		 LEFT JOIN tasks i ON i.id = hr.task_id
		 WHERE m.team_id = $1
		   AND ma.runtime_status = 'active'::agent_runtime_status
		   AND ma.admin_status <> 'disabled'::agent_admin_status
		 ORDER BY ma.title ASC`,
		[teamId],
	);
	return result.rows;
}

export async function getProjectDashboard(
	db: Db,
	projectId: string,
	teamId: string,
	adminUserId: string | null,
	signAgentIcon?: (agentId: string, iconUpdatedAt: string | null) => Promise<string | null>,
): Promise<ProjectDashboard | null> {
	const meta = await getProjectMeta(db, projectId, teamId);
	if (!meta) return null;

	const isInternal = meta.is_internal;

	const [spendBundle, progress, goals, inProgressTasks, needsYou, runningAgents] =
		await Promise.all([
			isInternal ? Promise.resolve(null) : getProjectSpendBundle(db, projectId),
			isInternal ? Promise.resolve(null) : getProjectProgress(db, projectId),
			isInternal ? Promise.resolve([]) : getGoalsPreview(db, projectId),
			getInProgressTasks(db, projectId),
			adminUserId
				? getNeedsYou(db, teamId, projectId, adminUserId)
				: Promise.resolve({ items: [], inbox_unread: 0 }),
			getRunningAgents(db, teamId),
		]);

	return {
		is_internal: isInternal,
		open_task_count: meta.open_task_count,
		running_agents_count: runningAgents.length,
		running_agents: await Promise.all(
			runningAgents.map(async (a) => ({
				id: a.id,
				slug: a.slug,
				title: a.title,
				icon_url: signAgentIcon ? await signAgentIcon(a.id, a.icon_updated_at) : null,
				task_id: a.task_id,
				task_identifier: a.task_identifier,
				task_in_current_project: a.task_project_id === projectId,
				run_status: a.run_status,
			})),
		),
		last_activity_at: meta.last_activity_at,
		container_status: meta.container_status,
		spend: { all_time_cents: spendBundle?.all_time_cents ?? 0 },
		budget: spendBundle?.budget ?? null,
		progress,
		goals: goals as ProjectDashboard['goals'],
		in_progress_tasks: inProgressTasks,
		needs_you: needsYou.items,
		inbox_unread: needsYou.inbox_unread,
	};
}
