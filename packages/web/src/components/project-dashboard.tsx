import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from '@dnd-kit/core';
import { arrayMove, rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
	ApprovalType,
	centsToDollars,
	type DashboardWidgetId,
	type DashboardWidgetOrder,
	type ProjectDashboardNeedsYouItem,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import {
	Activity,
	AlertTriangle,
	DollarSign,
	GripVertical,
	Inbox,
	KeyRound,
	ListTodo,
	Target,
} from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useState } from 'react';
import { useAgents } from '../hooks/use-agents';
import { useBudgetStatus, useCosts } from '../hooks/use-costs';
import { useDashboardWidgetOrder } from '../hooks/use-dashboard-widget-order';
import { useGoals } from '../hooks/use-goals';
import { useNeedsYou } from '../hooks/use-inbox-count';
import { useProject, useProjectMeta, useProjectProgress } from '../hooks/use-projects';
import { useTasks } from '../hooks/use-tasks';
import { agentAvatarUrl } from '../lib/agent-avatar';
import { DEFAULT_WIDGET_ORDER, sanitizeWidgetOrder } from '../lib/dashboard-widget-order';
import { inboxRowKind, inboxRowLead } from '../lib/inbox-row-kind';
import { agentDisplayName } from './agent-identity-tooltip';
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
import { StatusDot } from './ui/status-dot';

export { DEFAULT_WIDGET_ORDER, sanitizeWidgetOrder };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function relativeTimeAgo(iso: string): string {
	const t = relativeTime(iso);
	if (!t) return '';
	return t === 'now' ? 'now' : `${t} ago`;
}

function formatMoney(cents: number): string {
	return `$${centsToDollars(cents)}`;
}

function splitLead(summary: string): { lead: string } {
	const match = summary.match(/\n[ \t]*\n/);
	if (!match || match.index === undefined) return { lead: summary };
	return { lead: summary.slice(0, match.index).trimEnd() };
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

// ---------------------------------------------------------------------------
// Drag handle
// ---------------------------------------------------------------------------

function DragHandle({ listeners, attributes }: { listeners?: object; attributes?: object }) {
	return (
		<button
			type="button"
			className="flex cursor-grab items-center rounded p-0.5 text-text-3 opacity-0 transition-opacity hover:text-text-2 group-hover/widget:opacity-100 active:cursor-grabbing"
			aria-label="Drag to reorder widget"
			{...(listeners ?? {})}
			{...(attributes ?? {})}
		>
			<GripVertical className="h-3.5 w-3.5" aria-hidden />
		</button>
	);
}

function WidgetHeader({
	icon: Icon,
	title,
	action,
	dragListeners,
	dragAttributes,
}: {
	icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
	title: string;
	action?: ReactNode;
	dragListeners?: object;
	dragAttributes?: object;
}) {
	return (
		<div className="mb-3 flex items-start justify-between gap-3">
			<div className="flex items-center gap-1.5">
				{dragListeners || dragAttributes ? (
					<DragHandle listeners={dragListeners} attributes={dragAttributes} />
				) : null}
				<Icon className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
				<h2 className="text-sm font-medium text-text-1">{title}</h2>
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Needs You (Action items) — full width, no drag
// ---------------------------------------------------------------------------

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
	const m = row.mention;
	const kind = inboxRowKind(m.content_type);
	const lead = inboxRowLead(m);
	return (
		<NeedsYouRowShell
			tag={kind.tag}
			tagColor={kind.tagColor}
			createdAt={row.created_at}
			actionLink={
				<Link
					to="/projects/$projectId/tasks/$taskId"
					params={{ projectId, taskId: m.task_identifier.toLowerCase() }}
					hash={`comment-${m.comment_public_id}`}
					className={ACTION_LINK_CLASS}
				>
					{kind.actionLabel}
				</Link>
			}
		>
			{lead ? (
				<>
					{m.task_identifier}: {lead}
				</>
			) : (
				<>
					{m.author_display_name} on {m.task_identifier}: {m.snippet || m.task_title}
				</>
			)}
		</NeedsYouRowShell>
	);
}

function NeedsYouSection({
	projectId,
	rows,
	actionCount,
}: {
	projectId: string;
	rows: ProjectDashboardNeedsYouItem[];
	actionCount: number;
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
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="flex items-center gap-2">
					<Inbox className="h-4 w-4 shrink-0 text-text-3" aria-hidden />
					<h2 className="text-sm font-medium text-text-1">{`Action items · ${actionCount}`}</h2>
				</div>
				<div className="shrink-0">
					<Link
						to="/projects/$projectId/inbox"
						params={{ projectId }}
						className="text-xs text-info-soft-fg hover:underline"
					>
						Open inbox
					</Link>
				</div>
			</div>
			<Card className="divide-y divide-border p-0">
				{rows.map((row) => (
					<NeedsYouRow
						key={`${row.kind}-${row.kind === 'approval' ? row.approval.id : row.mention.id}`}
						projectId={projectId}
						row={row}
					/>
				))}
			</Card>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Widget sections
// ---------------------------------------------------------------------------

function SpendWidget({
	projectId,
	dragListeners,
	dragAttributes,
}: {
	projectId: string;
	dragListeners?: object;
	dragAttributes?: object;
}) {
	const { data: budget } = useBudgetStatus(projectId);
	const allTimeCents = useTotalSpend(projectId);
	if (!budget) return null;

	const { project: p } = budget;
	const windows = [
		{ label: 'Today', cents: p.daily.spentCents, capCents: p.daily.limitCents },
		{ label: 'This week', cents: p.weekly.spentCents, capCents: p.weekly.limitCents },
		{ label: 'This month', cents: p.monthly.spentCents, capCents: p.monthly.limitCents },
		{ label: 'All time', cents: allTimeCents, capCents: null as number | null },
	];

	return (
		<section data-testid="project-dashboard-spend">
			<WidgetHeader
				icon={DollarSign}
				title="Spend"
				dragListeners={dragListeners}
				dragAttributes={dragAttributes}
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
				{p.monthly.limitCents > 0 && (
					<div className="border-t border-border px-4 py-3">
						<div className="mb-1.5 flex items-center justify-between text-[12px]">
							<span className="text-text-2">Monthly cap</span>
							<span className={`font-mono ${p.monthly.overBudget ? 'text-danger' : 'text-text-1'}`}>
								{formatMoney(p.monthly.spentCents)} / {formatMoney(p.monthly.limitCents)}
							</span>
						</div>
						<BudgetBar used={p.monthly.spentCents} total={p.monthly.limitCents} />
					</div>
				)}
			</Card>
		</section>
	);
}

/** All-time spend total from the costs summary endpoint. */
function useTotalSpend(projectId: string): number {
	const { data } = useCosts(projectId);
	if (!data) return 0;
	return data.total_cents;
}

function InProgressWidget({
	projectId,
	dragListeners,
	dragAttributes,
}: {
	projectId: string;
	dragListeners?: object;
	dragAttributes?: object;
}) {
	const { data } = useTasks(projectId, {
		status: 'in_progress,review',
		sort: 'updated_at:desc',
		per_page: '10',
	});
	const tasks = data?.data ?? [];

	return (
		<section data-testid="project-dashboard-in-progress">
			<WidgetHeader
				icon={ListTodo}
				title="In progress"
				dragListeners={dragListeners}
				dragAttributes={dragAttributes}
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
				<Card className="flex min-h-[88px] items-center justify-center px-4 py-3">
					<div className="text-center">
						<h3 className="text-sm font-medium text-text-1">Nothing in progress</h3>
						<p className="mt-1 text-sm text-text-2">
							Tasks in progress or review will appear here.
						</p>
					</div>
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

function ProgressWidget({
	projectId,
	dragListeners,
	dragAttributes,
}: {
	projectId: string;
	dragListeners?: object;
	dragAttributes?: object;
}) {
	const { data: progress } = useProjectProgress(projectId);
	const summary = progress?.summary?.trim() ?? '';
	if (!summary) return null;
	const { lead } = splitLead(summary);

	return (
		<section data-testid="project-dashboard-progress">
			<WidgetHeader
				icon={Activity}
				title="Status"
				dragListeners={dragListeners}
				dragAttributes={dragAttributes}
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

function GoalsWidget({
	projectId,
	dragListeners,
	dragAttributes,
}: {
	projectId: string;
	dragListeners?: object;
	dragAttributes?: object;
}) {
	const { data: goals } = useGoals(projectId);
	const preview = (goals ?? []).slice(0, 3);
	if (preview.length === 0) return null;

	return (
		<section data-testid="project-dashboard-goals">
			<WidgetHeader
				icon={Target}
				title="Goals"
				dragListeners={dragListeners}
				dragAttributes={dragAttributes}
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
				{preview.map((goal) => (
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

function TeamSnapshotWidget({
	projectId,
	dragListeners,
	dragAttributes,
}: {
	projectId: string;
	dragListeners?: object;
	dragAttributes?: object;
}) {
	const project = useProjectMeta(projectId);
	const { data: agents } = useAgents(projectId, 'enabled');
	const currentProjectId = project?.id;

	const runningAgents = (agents ?? []).filter((a) => a.active_run?.run_status === 'running');
	const containerIssue =
		project?.container_status === 'error' ||
		project?.container_status === 'stopped' ||
		project?.container_status === 'creating';

	return (
		<section data-testid="project-dashboard-team">
			<WidgetHeader
				icon={Activity}
				title="Team snapshot"
				dragListeners={dragListeners}
				dragAttributes={dragAttributes}
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
						{runningAgents.length > 0 ? (
							<span className="text-live">{runningAgents.length} running</span>
						) : (
							<span>No agents running</span>
						)}
						<span>{project?.open_task_count ?? 0} open tasks</span>
						{project?.last_activity_at && (
							<span>Active {relativeTimeAgo(project.last_activity_at)}</span>
						)}
					</div>
					{containerIssue && (
						<span className="inline-flex items-center gap-1 text-danger">
							<AlertTriangle className="h-3.5 w-3.5" aria-hidden />
							Container {project?.container_status}
						</span>
					)}
				</div>
				{runningAgents.length > 0 && (
					<div className="divide-y divide-border border-t border-border">
						{runningAgents.map((agent) => {
							const run = agent.active_run;
							const working = run?.run_status === 'running';
							const statusLabel = working ? 'Working' : 'Queued';
							return (
								<div
									key={agent.id}
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
											initials={getInitials(agentDisplayName(agent))}
											imageUrl={agentAvatarUrl({
												slug: agent.slug,
												avatar_spec: agent.avatar_spec,
											})}
										/>
										<span className="min-w-0 truncate text-[13px] font-medium text-text-1">
											{agentDisplayName(agent)}
										</span>
									</Link>
									{run?.task_identifier &&
									run.task_id &&
									currentProjectId &&
									run.task_project_id === currentProjectId ? (
										<Link
											to="/projects/$projectId/tasks/$taskId"
											params={{ projectId, taskId: run.task_identifier.toLowerCase() }}
											className="shrink-0 font-mono text-[12px] text-text-3 hover:text-text-1 hover:underline"
										>
											{run.task_identifier}
										</Link>
									) : null}
									<StatusDot status="active" pulse={working} label={statusLabel} />
								</div>
							);
						})}
					</div>
				)}
			</Card>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Sortable widget wrapper
// ---------------------------------------------------------------------------

function SortableWidget({
	id,
	children,
}: {
	id: DashboardWidgetId;
	children: (dragListeners: object, dragAttributes: object) => ReactNode;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id,
	});

	const style: CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.4 : undefined,
	};

	return (
		<div ref={setNodeRef} style={style} className="group/widget">
			{children(listeners ?? {}, attributes ?? {})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Widget grid
// ---------------------------------------------------------------------------

function WidgetGrid({
	projectId,
	isInternal,
	order,
	onOrderChange,
}: {
	projectId: string;
	isInternal: boolean;
	order: DashboardWidgetOrder;
	onOrderChange: (next: DashboardWidgetOrder) => void;
}) {
	const [localOrder, setLocalOrder] = useState<DashboardWidgetOrder | null>(null);
	const [activeId, setActiveId] = useState<DashboardWidgetId | null>(null);

	const displayOrder: DashboardWidgetOrder = localOrder ?? order;

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor),
	);

	function handleDragEnd(event: DragEndEvent) {
		const { active, over } = event;
		setActiveId(null);
		if (!over || active.id === over.id) return;
		const oldIndex = displayOrder.indexOf(active.id as DashboardWidgetId);
		const newIndex = displayOrder.indexOf(over.id as DashboardWidgetId);
		if (oldIndex === -1 || newIndex === -1) return;
		const next = arrayMove(displayOrder, oldIndex, newIndex);
		setLocalOrder(next);
		onOrderChange(next);
	}

	function renderWidget(id: DashboardWidgetId, listeners: object, attributes: object): ReactNode {
		switch (id) {
			case 'goals':
				return isInternal ? null : (
					<GoalsWidget
						projectId={projectId}
						dragListeners={listeners}
						dragAttributes={attributes}
					/>
				);
			case 'team_snapshot':
				return (
					<TeamSnapshotWidget
						projectId={projectId}
						dragListeners={listeners}
						dragAttributes={attributes}
					/>
				);
			case 'in_progress':
				return (
					<InProgressWidget
						projectId={projectId}
						dragListeners={listeners}
						dragAttributes={attributes}
					/>
				);
			case 'spend':
				return isInternal ? null : (
					<SpendWidget
						projectId={projectId}
						dragListeners={listeners}
						dragAttributes={attributes}
					/>
				);
			default:
				return null;
		}
	}

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragStart={({ active }) => setActiveId(active.id as DashboardWidgetId)}
			onDragEnd={handleDragEnd}
		>
			<SortableContext items={displayOrder} strategy={rectSortingStrategy}>
				<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
					{displayOrder.map((id) => (
						<SortableWidget key={id} id={id}>
							{(listeners, attributes) => renderWidget(id, listeners, attributes)}
						</SortableWidget>
					))}
				</div>
			</SortableContext>
			<DragOverlay>
				{activeId ? (
					<div className="rounded-lg border border-border bg-surface opacity-90 shadow-lg">
						{renderWidget(activeId, {}, {})}
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function DashboardSkeleton() {
	return (
		<div className="flex flex-col gap-6" data-testid="project-dashboard-loading">
			<div className="h-8 w-48 animate-pulse rounded bg-surface-2" />
			<div className="h-32 w-full animate-pulse rounded-lg bg-surface-2" />
			<div className="h-40 w-full animate-pulse rounded-lg bg-surface-2" />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function ProjectDashboardView({ projectId }: { projectId: string }) {
	const projectMeta = useProjectMeta(projectId);
	// Full project detail carries dashboard_widget_order.
	const { data: project, isLoading } = useProject(projectId);
	const { data: needsYou } = useNeedsYou(projectId);
	const { mutate: saveOrder } = useDashboardWidgetOrder(projectId);

	if (isLoading && !projectMeta) return <DashboardSkeleton />;

	const isInternal = project?.is_internal ?? projectMeta?.is_internal ?? false;
	const widgetOrder = sanitizeWidgetOrder(project?.dashboard_widget_order);

	return (
		<div className="flex flex-col gap-6" data-testid="project-dashboard">
			<header>
				<h1 className="text-xl font-semibold text-text-1">
					{project?.name ?? projectMeta?.name ?? projectId}
				</h1>
			</header>

			{isInternal ? null : <ProgressWidget projectId={projectId} />}

			<NeedsYouSection
				projectId={projectId}
				rows={needsYou?.items ?? []}
				actionCount={needsYou?.action_count ?? 0}
			/>

			<WidgetGrid
				projectId={projectId}
				isInternal={isInternal}
				order={widgetOrder}
				onOrderChange={saveOrder}
			/>

			{isInternal && (needsYou?.items ?? []).length === 0 && (
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
