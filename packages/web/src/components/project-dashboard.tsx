import {
	ApprovalType,
	centsToDollars,
	type ProjectDashboard,
	type ProjectDashboardNeedsYouItem,
	type ProjectDashboardRunningAgent,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import {
	Activity,
	AlertTriangle,
	DollarSign,
	Inbox,
	KeyRound,
	ListTodo,
	Target,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useProjectDashboard } from '../hooks/use-project-dashboard';
import { useProjectMeta } from '../hooks/use-projects';
import { defaultAvatarForSlug } from '../lib/default-avatars';
import { agentPageParams } from './agent-link';
import { GoalHealthPill } from './goal-health-pill';
import { MarkdownProse } from './markdown-prose';
import { TaskRunDot } from './task-run-dot';
import { TaskStatusBadge } from './task-status-badge';
import { Avatar, getInitials } from './ui/avatar';
import { Badge } from './ui/badge';
import { BudgetBar } from './ui/budget-bar';
import { Card } from './ui/card';
import { EmptyState } from './ui/empty-state';
import { SectionHeader } from './ui/section-header';
import { StatusDot } from './ui/status-dot';

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	['day', 86400],
	['hour', 3600],
	['minute', 60],
];

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return '';
	const deltaSec = Math.round((Date.now() - then) / 1000);
	for (const [unit, per] of RELATIVE_UNITS) {
		if (deltaSec >= per) {
			const n = Math.floor(deltaSec / per);
			return `${n}${unit[0]}`;
		}
	}
	return 'now';
}

/** Compact relative label with "ago" suffix, except when the time is "now". */
function relativeTimeAgo(iso: string): string {
	const t = relativeTime(iso);
	if (!t) return '';
	return t === 'now' ? 'now' : `${t} ago`;
}

function formatMoney(cents: number): string {
	return `$${centsToDollars(cents)}`;
}

function splitLead(summary: string): { lead: string; body: string } {
	const match = summary.match(/\n[ \t]*\n/);
	if (!match || match.index === undefined) return { lead: summary, body: '' };
	return {
		lead: summary.slice(0, match.index).trimEnd(),
		body: summary.slice(match.index + match[0].length).trim(),
	};
}

function approvalText(approval: { type: string; requested_by_name: string | null }): string {
	const who = approval.requested_by_name ?? 'An agent';
	switch (approval.type) {
		case ApprovalType.DesignatedRepoRequest:
			return `${who} needs GitHub access to set up the repo`;
		case ApprovalType.PlanReview:
			return `${who} drafted a plan to review`;
		case ApprovalType.Hire:
			return `${who} wants to hire an agent`;
		case ApprovalType.DeployProduction:
			return `${who} wants to deploy to production`;
		case ApprovalType.SkillProposal:
			return `${who} proposed a reusable skill`;
		case ApprovalType.Strategy:
			return `${who} needs a strategy decision`;
		case ApprovalType.ProjectCreation:
			return `${who} proposed a new project`;
		default:
			return `${who} needs your approval`;
	}
}

function approvalActionLabel(type: string): string {
	if (type === ApprovalType.DesignatedRepoRequest) return 'Set up';
	if (type === ApprovalType.PlanReview) return 'Open plan';
	if (type === ApprovalType.SkillProposal) return 'Review';
	return 'Open';
}

const ACTION_LINK_CLASS =
	'shrink-0 rounded-md border border-border px-2 py-1 text-[12px] text-text-1 hover:bg-surface-2';

function NeedsYouRowShell({
	tag,
	tagColor,
	children,
	createdAt,
	actionLink,
}: {
	tag: string;
	tagColor: 'accent' | 'info' | 'warning';
	children: ReactNode;
	createdAt: string;
	actionLink: ReactNode;
}) {
	return (
		<div
			className="flex items-center gap-3 px-3 py-2.5"
			data-testid="project-dashboard-needs-you-row"
		>
			<Badge color={tagColor} mono className="shrink-0">
				{tag}
			</Badge>
			<span className="min-w-0 flex-1 truncate text-[13px] text-text-1">{children}</span>
			<span className="shrink-0 font-mono text-[11px] text-text-3">{relativeTime(createdAt)}</span>
			{actionLink}
		</div>
	);
}

function NeedsYouRow({ projectId, row }: { projectId: string; row: ProjectDashboardNeedsYouItem }) {
	if (row.kind === 'approval') {
		return (
			<NeedsYouRowShell
				tag="action"
				tagColor="accent"
				createdAt={row.created_at}
				actionLink={
					<Link
						to="/projects/$projectId/inbox"
						params={{ projectId }}
						className={ACTION_LINK_CLASS}
					>
						{approvalActionLabel(row.approval.type)}
					</Link>
				}
			>
				{approvalText(row.approval)}
			</NeedsYouRowShell>
		);
	}
	if (row.kind === 'mention') {
		const m = row.mention;
		return (
			<NeedsYouRowShell
				tag="mention"
				tagColor="info"
				createdAt={row.created_at}
				actionLink={
					<Link
						to="/projects/$projectId/tasks/$taskId"
						params={{ projectId, taskId: m.task_identifier.toLowerCase() }}
						hash={`comment-${m.comment_public_id}`}
						className={ACTION_LINK_CLASS}
					>
						Reply
					</Link>
				}
			>
				{m.author_display_name} on {m.task_identifier}: {m.snippet || m.task_title}
			</NeedsYouRowShell>
		);
	}
	const c = row.credential;
	return (
		<NeedsYouRowShell
			tag="credential"
			tagColor="warning"
			createdAt={row.created_at}
			actionLink={
				<Link
					to="/projects/$projectId/tasks/$taskId"
					params={{ projectId, taskId: c.task_identifier.toLowerCase() }}
					hash={`comment-${c.comment_public_id}`}
					className={ACTION_LINK_CLASS}
				>
					Provide
				</Link>
			}
		>
			{c.task_identifier}: provide {c.credential_name}
		</NeedsYouRowShell>
	);
}

function DashboardSkeleton() {
	return (
		<div className="flex flex-col gap-6" data-testid="project-dashboard-loading">
			<div className="h-8 w-48 animate-pulse rounded bg-surface-2" />
			<div className="h-32 w-full animate-pulse rounded-lg bg-surface-2" />
			<div className="h-40 w-full animate-pulse rounded-lg bg-surface-2" />
		</div>
	);
}

function SpendSection({
	projectId,
	spend,
	budget,
}: {
	projectId: string;
	spend: ProjectDashboard['spend'];
	budget: ProjectDashboard['budget'];
}) {
	if (!budget) return null;

	const windows = [
		{ label: 'Today', cents: budget.daily.spentCents, capCents: budget.daily.limitCents },
		{ label: 'This week', cents: budget.weekly.spentCents, capCents: budget.weekly.limitCents },
		{ label: 'This month', cents: budget.monthly.spentCents, capCents: budget.monthly.limitCents },
		{ label: 'All time', cents: spend.all_time_cents, capCents: null as number | null },
	];

	return (
		<section data-testid="project-dashboard-spend">
			<SectionHeader
				icon={DollarSign}
				title="Spend"
				action={
					<Link
						to="/projects/$projectId/budget"
						params={{ projectId }}
						className="text-xs text-info-soft-fg hover:underline"
					>
						View budget
					</Link>
				}
			/>
			<Card className="p-0">
				<div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
					{windows.map((w) => (
						<div key={w.label} className="bg-surface px-4 py-3">
							<p className="text-[11px] uppercase tracking-wide text-text-3">{w.label}</p>
							<p className="mt-1 font-mono text-lg text-text-1">{formatMoney(w.cents)}</p>
							{w.capCents != null && (
								<p className="mt-0.5 font-mono text-[11px] text-text-3">
									{w.capCents > 0 ? `cap ${formatMoney(w.capCents)}` : 'cap not set'}
								</p>
							)}
						</div>
					))}
				</div>
				{budget && budget.monthly.limitCents > 0 && (
					<div className="border-t border-border px-4 py-3">
						<div className="mb-1.5 flex items-center justify-between text-[12px]">
							<span className="text-text-2">Monthly cap</span>
							<span
								className={`font-mono ${budget.monthly.overBudget ? 'text-danger' : 'text-text-1'}`}
							>
								{formatMoney(budget.monthly.spentCents)} / {formatMoney(budget.monthly.limitCents)}
							</span>
						</div>
						<BudgetBar used={budget.monthly.spentCents} total={budget.monthly.limitCents} />
					</div>
				)}
			</Card>
		</section>
	);
}

function InProgressSection({
	projectId,
	tasks,
}: {
	projectId: string;
	tasks: ProjectDashboard['in_progress_tasks'];
}) {
	return (
		<section data-testid="project-dashboard-in-progress">
			<SectionHeader
				icon={ListTodo}
				title="In progress"
				action={
					<Link
						to="/projects/$projectId/tasks"
						params={{ projectId }}
						className="text-xs text-info-soft-fg hover:underline"
					>
						View tasks
					</Link>
				}
			/>
			{tasks.length === 0 ? (
				<Card>
					<EmptyState
						title="Nothing in progress"
						description="Tasks in progress or review will appear here."
					/>
				</Card>
			) : (
				<Card className="divide-y divide-border p-0">
					{tasks.map((task) => (
						<Link
							key={task.id}
							to="/projects/$projectId/tasks/$taskId"
							params={{ projectId, taskId: task.identifier.toLowerCase() }}
							className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2"
							data-testid="project-dashboard-task-row"
						>
							<TaskRunDot hasActiveRun={task.has_active_run} queuedWakeup={task.queued_wakeup} />
							<span className="shrink-0 font-mono text-[12px] text-text-3">{task.identifier}</span>
							<span className="min-w-0 flex-1 truncate text-[13px] text-text-1">{task.title}</span>
							{task.assignee_name && (
								<span className="hidden shrink-0 text-[12px] text-text-3 sm:inline">
									{task.assignee_name}
								</span>
							)}
							<TaskStatusBadge status={task.status} />
						</Link>
					))}
				</Card>
			)}
		</section>
	);
}

function ProgressSection({
	projectId,
	progress,
}: {
	projectId: string;
	progress: ProjectDashboard['progress'];
}) {
	const summary = progress?.summary?.trim() ?? '';
	if (!summary) return null;
	const { lead } = splitLead(summary);

	return (
		<section data-testid="project-dashboard-progress">
			<SectionHeader
				icon={Activity}
				title="Progress"
				action={
					<Link
						to="/projects/$projectId/goals"
						params={{ projectId }}
						className="text-xs text-info-soft-fg hover:underline"
					>
						View goals
					</Link>
				}
			/>
			<Card>
				<div className="text-sm text-text-2 line-clamp-4">
					<MarkdownProse>{lead}</MarkdownProse>
				</div>
				{progress?.updated_at && (
					<p className="mt-2 text-[11px] text-text-3">
						Updated {relativeTimeAgo(progress.updated_at)}
					</p>
				)}
			</Card>
		</section>
	);
}

function GoalsSection({
	projectId,
	goals,
}: {
	projectId: string;
	goals: ProjectDashboard['goals'];
}) {
	if (goals.length === 0) return null;

	return (
		<section data-testid="project-dashboard-goals">
			<SectionHeader
				icon={Target}
				title="Goals"
				action={
					<Link
						to="/projects/$projectId/goals"
						params={{ projectId }}
						className="text-xs text-info-soft-fg hover:underline"
					>
						View goals
					</Link>
				}
			/>
			<Card className="divide-y divide-border p-0">
				{goals.map((goal) => (
					<Link
						key={goal.id}
						to="/projects/$projectId/goals/$goalId"
						params={{ projectId, goalId: goal.id }}
						className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2"
					>
						<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-1">
							{goal.title}
						</span>
						<span className="shrink-0 font-mono text-[12px] text-text-3">
							{goal.progress_percent}%
						</span>
						<GoalHealthPill health={goal.health} />
					</Link>
				))}
			</Card>
		</section>
	);
}

function RunningAgentRow({
	projectId,
	agent,
}: {
	projectId: string;
	agent: ProjectDashboardRunningAgent;
}) {
	const working = agent.run_status === 'running';
	const statusLabel = working ? 'Working' : agent.run_status === 'queued' ? 'Queued' : 'Running';

	return (
		<div
			className="flex items-center gap-2 px-3 py-2"
			data-testid="project-dashboard-running-agent"
		>
			<Link
				to="/projects/$projectId/agents/$agentId"
				params={agentPageParams(projectId, agent.slug)}
				className="flex min-w-0 flex-1 items-center gap-2 hover:opacity-80"
			>
				<Avatar
					size="sm"
					initials={getInitials(agent.title)}
					imageUrl={agent.icon_url ?? defaultAvatarForSlug(agent.slug)}
				/>
				<span className="min-w-0 truncate text-[13px] font-medium text-text-1">{agent.title}</span>
			</Link>
			{agent.task_identifier && agent.task_id && agent.task_in_current_project ? (
				<Link
					to="/projects/$projectId/tasks/$taskId"
					params={{ projectId, taskId: agent.task_identifier.toLowerCase() }}
					className="shrink-0 font-mono text-[12px] text-text-3 hover:text-text-1 hover:underline"
				>
					{agent.task_identifier}
				</Link>
			) : null}
			<StatusDot status="active" pulse={working} label={statusLabel} />
		</div>
	);
}

function TeamSnapshot({ data, projectId }: { data: ProjectDashboard; projectId: string }) {
	const containerIssue =
		data.container_status === 'error' ||
		data.container_status === 'stopped' ||
		data.container_status === 'creating';

	return (
		<section data-testid="project-dashboard-team">
			<SectionHeader
				icon={Activity}
				title="Team snapshot"
				action={
					<Link
						to="/projects/$projectId/agents"
						params={{ projectId }}
						className="text-xs text-info-soft-fg hover:underline"
					>
						View team
					</Link>
				}
			/>
			<Card className="flex flex-col gap-0 p-0 text-[13px] text-text-2">
				<div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						{data.running_agents_count > 0 ? (
							<span className="text-live">{data.running_agents_count} running</span>
						) : (
							<span>No agents running</span>
						)}
						<span>{data.open_task_count} open tasks</span>
						<span>Active {relativeTimeAgo(data.last_activity_at)}</span>
					</div>
					{containerIssue && (
						<span className="inline-flex items-center gap-1 text-danger">
							<AlertTriangle className="h-3.5 w-3.5" aria-hidden />
							Container {data.container_status}
						</span>
					)}
				</div>
				{data.running_agents.length > 0 && (
					<div className="divide-y divide-border border-t border-border">
						{data.running_agents.map((agent) => (
							<RunningAgentRow key={agent.id} projectId={projectId} agent={agent} />
						))}
					</div>
				)}
			</Card>
		</section>
	);
}

function NeedsYouSection({
	projectId,
	rows,
	unreadCount,
}: {
	projectId: string;
	rows: ProjectDashboardNeedsYouItem[];
	unreadCount: number;
}) {
	if (rows.length === 0) {
		return (
			<section data-testid="project-dashboard-needs-you">
				<div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]">
					<Inbox className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
					<span className="font-medium text-text-1">Action items</span>
					<span className="text-text-3">· All caught up</span>
				</div>
			</section>
		);
	}

	return (
		<section data-testid="project-dashboard-needs-you">
			<SectionHeader
				icon={Inbox}
				title={`Action items · ${unreadCount}`}
				action={
					<Link
						to="/projects/$projectId/inbox"
						params={{ projectId }}
						className="text-xs text-info-soft-fg hover:underline"
					>
						Open inbox
					</Link>
				}
			/>
			<Card className="divide-y divide-border p-0">
				{rows.map((row) => (
					<NeedsYouRow
						key={`${row.kind}-${row.kind === 'approval' ? row.approval.id : row.kind === 'mention' ? row.mention.id : row.credential.comment_id}`}
						projectId={projectId}
						row={row}
					/>
				))}
			</Card>
		</section>
	);
}

export function ProjectDashboardView({ projectId }: { projectId: string }) {
	const project = useProjectMeta(projectId);
	const { data, isLoading, isError } = useProjectDashboard(projectId);

	if (isLoading) return <DashboardSkeleton />;
	if (isError || !data) {
		return (
			<EmptyState
				title="Could not load dashboard"
				description="Try refreshing the page."
				variant="hero"
			/>
		);
	}

	const isInternal = data.is_internal;

	return (
		<div className="flex flex-col gap-6" data-testid="project-dashboard">
			<header>
				<h1 className="text-xl font-semibold text-text-1">{project?.name ?? 'Project'}</h1>
			</header>

			<NeedsYouSection
				projectId={projectId}
				rows={data.needs_you}
				unreadCount={data.inbox_unread}
			/>

			<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
				<div className="flex flex-col gap-6">
					{!isInternal && (
						<SpendSection projectId={projectId} spend={data.spend} budget={data.budget} />
					)}
					<InProgressSection projectId={projectId} tasks={data.in_progress_tasks} />
				</div>
				<div className="flex flex-col gap-6">
					{!isInternal && (
						<>
							<ProgressSection projectId={projectId} progress={data.progress} />
							<GoalsSection projectId={projectId} goals={data.goals} />
						</>
					)}
					<TeamSnapshot data={data} projectId={projectId} />
				</div>
			</div>

			{isInternal && data.needs_you.length === 0 && data.in_progress_tasks.length === 0 && (
				<Card>
					<EmptyState
						icon={<KeyRound className="h-5 w-5" />}
						title="HQ is ready"
						description="Check Tasks or chat with the CEO to get started."
					/>
				</Card>
			)}
		</div>
	);
}
