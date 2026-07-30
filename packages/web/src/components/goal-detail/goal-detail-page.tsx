import {
	GOAL_CHECK_FREQUENCY_LABELS,
	type GoalRunActivity,
	HeartbeatRunStatus,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useGoal, useGoalHistory, useGoalRunActivity } from '../../hooks/use-goals';
import { formatDateTime, formatRelativeTime } from '../../lib/format-date';
import { useI18n } from '../../lib/i18n';
import { agentPageParams } from '../agent-link';
import { CreateGoalDialog } from '../create-goal-dialog';
import { GoalArchiveButton } from '../goal-archive-button';
import { GoalHealthPill } from '../goal-health-pill';
import { GoalProgressChart } from '../goal-progress-chart';
import { InfiniteScrollSentinel } from '../infinite-scroll-sentinel';
import { MarkdownProse } from '../markdown-prose';
import { Badge, type BadgeColor } from '../ui/badge';

interface GoalDetailPageProps {
	projectId: string;
	goalId: string;
}

function formatTargetDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The timestamp a run row is labelled by: when it finished, else started, else was created. */
function runActivityIso(run: GoalRunActivity): string {
	return run.finished_at ?? run.started_at ?? run.created_at;
}

const RUN_STATUS_COLOR: Record<string, BadgeColor> = {
	[HeartbeatRunStatus.Queued]: 'neutral',
	[HeartbeatRunStatus.Running]: 'info',
	[HeartbeatRunStatus.Succeeded]: 'success',
	[HeartbeatRunStatus.Failed]: 'danger',
	[HeartbeatRunStatus.Cancelled]: 'neutral',
	[HeartbeatRunStatus.TimedOut]: 'warning',
};

function TaskChip({ projectId, identifier }: { projectId: string; identifier: string }) {
	return (
		<Link
			to="/projects/$projectId/tasks/$taskId"
			params={{ projectId, taskId: identifier.toLowerCase() }}
			className="font-mono text-info-soft-fg hover:underline"
		>
			{identifier}
		</Link>
	);
}

function GoalRunRow({ projectId, run }: { projectId: string; run: GoalRunActivity }) {
	// The whole row is a stretched link to this run in the Captain's run list. The expand
	// toggle and task chips sit above the overlay (`relative z-10`) so they stay clickable.
	const runLinkParams = { ...agentPageParams(projectId, run.agent_slug), runId: run.id };
	const [expanded, setExpanded] = useState(false);
	const blurb = run.progress?.status_blurb;
	const blurbId = `goal-run-blurb-${run.id}`;
	return (
		<li
			data-testid="goal-run"
			className="relative flex flex-col gap-1.5 px-3 py-2.5 transition-colors hover:bg-surface-2"
		>
			<div className="flex flex-wrap items-center gap-2">
				<Link
					to="/projects/$projectId/agents/$agentId/executions/$runId"
					params={runLinkParams}
					data-testid="goal-run-open"
					aria-label="Open run"
					title={formatDateTime(runActivityIso(run))}
					className="text-[13px] text-text-2 hover:underline before:absolute before:inset-0"
				>
					{formatRelativeTime(runActivityIso(run))}
				</Link>
				{run.status !== HeartbeatRunStatus.Succeeded && (
					<Badge color={RUN_STATUS_COLOR[run.status] ?? 'neutral'}>{run.status}</Badge>
				)}
				{run.progress && (
					<span className="flex items-center gap-1.5 text-xs text-text-3">
						<span>{run.progress.progress_percent}%</span>
						<GoalHealthPill health={run.progress.health} />
					</span>
				)}
				{/* The status summary is hidden by default; the chevron reveals it inline. Task
				    chips below stay visible in both states. */}
				{blurb && (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
						aria-controls={blurbId}
						aria-label={expanded ? 'Hide progress summary' : 'Show progress summary'}
						data-testid="goal-run-expand"
						className="relative z-10 ml-auto flex shrink-0 items-center text-text-3 transition-colors hover:text-text-1"
					>
						<svg
							aria-hidden="true"
							className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
							viewBox="0 0 16 16"
							fill="currentColor"
						>
							<path d="M6 3l5 5-5 5V3z" />
						</svg>
					</button>
				)}
			</div>
			{blurb && expanded && (
				// `relative z-10` lifts the blurb's task/PR links above the row's stretched
				// "open run" overlay so they stay clickable; the wrapping id preserves aria-controls.
				<div id={blurbId} className="relative z-10 break-words">
					<MarkdownProse projectId={projectId} projectSlug={projectId}>
						{blurb}
					</MarkdownProse>
				</div>
			)}
			{run.created_tasks.length > 0 && (
				<p className="relative z-10 self-start text-xs text-text-3">
					Created{' '}
					{run.created_tasks.map((t, i) => (
						<span key={t.id}>
							{i > 0 && ', '}
							<TaskChip projectId={projectId} identifier={t.identifier} />
						</span>
					))}
				</p>
			)}
			{run.commented_tasks.length > 0 && (
				<p className="relative z-10 self-start text-xs text-text-3">
					Commented on{' '}
					{run.commented_tasks.map((t, i) => (
						<span key={t.id}>
							{i > 0 && ', '}
							<TaskChip projectId={projectId} identifier={t.identifier} />
							{t.comment_count > 1 ? ` (${t.comment_count})` : ''}
						</span>
					))}
				</p>
			)}
		</li>
	);
}

function GoalRunsFeed({ projectId, goalId }: { projectId: string; goalId: string }) {
	const { t } = useI18n();
	const {
		data: runPages,
		isLoading,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useGoalRunActivity(projectId, goalId);
	// Flatten accumulated pages, deduping by id (offset pagination can transiently
	// overlap a page boundary when a new run prepends).
	const runs = useMemo(() => {
		const seen = new Set<string>();
		return (runPages?.pages.flatMap((p) => p.data) ?? []).filter((run) =>
			seen.has(run.id) ? false : (seen.add(run.id), true),
		);
	}, [runPages]);

	return (
		<section data-testid="goal-runs" className="mt-8">
			<h2 className="mb-2 px-0.5 text-[11px] font-medium uppercase tracking-wider text-text-3">
				Progress update runs
			</h2>
			{isLoading ? (
				<div className="py-6 text-center text-[13px] text-text-3">{t('common.loading')}</div>
			) : runs.length === 0 ? (
				<div
					data-testid="goal-runs-empty"
					className="rounded-md border border-border bg-surface px-3 py-6 text-center text-[13px] text-text-3"
				>
					No progress-update activity yet.
				</div>
			) : (
				<>
					<ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
						{runs.map((run) => (
							<GoalRunRow key={run.id} projectId={projectId} run={run} />
						))}
					</ul>
					<InfiniteScrollSentinel
						hasNextPage={hasNextPage}
						isFetchingNextPage={isFetchingNextPage}
						onLoadMore={fetchNextPage}
						testId="goal-runs"
					/>
				</>
			)}
		</section>
	);
}

export function GoalDetailPage({ projectId, goalId }: GoalDetailPageProps) {
	const { t } = useI18n();
	const { data: goal, isLoading } = useGoal(projectId, goalId);
	const { data: history } = useGoalHistory(projectId, goalId);
	const [editOpen, setEditOpen] = useState(false);

	if (isLoading) {
		return <div className="py-8 text-center text-[13px] text-text-2">{t('common.loading')}</div>;
	}
	if (!goal) {
		return (
			<div className="py-8 text-center text-[13px] text-text-2" data-testid="goal-not-found">
				Goal not found.
			</div>
		);
	}

	const isArchived = !!goal.archived_at;
	const percent = Math.max(0, Math.min(100, Math.round(goal.progress_percent)));

	return (
		<div className="max-w-3xl">
			<nav
				aria-label="Breadcrumb"
				data-testid="goal-breadcrumb"
				className="mb-2 flex flex-wrap items-center gap-x-1 text-[13px] text-text-2"
			>
				<Link
					to="/projects/$projectId/goals"
					params={{ projectId }}
					className="hover:text-text-1 hover:underline transition-colors"
				>
					Progress
				</Link>
				<ChevronRight className="w-3 h-3 shrink-0 text-text-3" />
				<span aria-current="page" className="text-text-1 break-words">
					{goal.title}
				</span>
			</nav>

			<div className="mb-4 flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-2">
					<h1 className="text-xl font-medium text-text-1 break-words">{goal.title}</h1>
					<div className="flex flex-wrap items-center gap-2">
						<GoalHealthPill health={goal.health} testId="goal-health-pill" />
						{isArchived && <Badge color="neutral">Archived</Badge>}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						onClick={() => setEditOpen(true)}
						aria-label="Edit goal"
						title="Edit goal"
						data-testid="goal-edit"
						className="p-1 text-text-3 transition-colors hover:text-text-1"
					>
						<Pencil className="h-4 w-4" />
					</button>
					<GoalArchiveButton projectId={projectId} goal={goal} />
				</div>
			</div>

			<div className="mb-4 flex flex-col gap-1.5 rounded-md border border-border bg-surface p-4">
				<span className="text-3xl font-semibold text-text-1">{percent}%</span>
				<div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
					<div
						className="h-full rounded-full bg-accent-solid transition-all"
						style={{ width: `${percent}%` }}
						data-testid="goal-progress-bar"
					/>
				</div>
				<div className="mt-3">
					<GoalProgressChart history={history ?? goal.history} size="full" />
				</div>
			</div>

			{goal.status_blurb && (
				<div className="mb-4 break-words">
					<MarkdownProse projectId={projectId} projectSlug={projectId}>
						{goal.status_blurb}
					</MarkdownProse>
				</div>
			)}

			<dl className="mb-2 flex flex-col gap-3 rounded-md border border-border bg-surface p-4 text-[13px]">
				{goal.measurement && (
					<div>
						<dt className="text-xs font-medium text-text-2">Achieved when</dt>
						<dd className="text-text-3 break-words">{goal.measurement}</dd>
					</div>
				)}
				{goal.actions && (
					<div>
						<dt className="text-xs font-medium text-text-2">Suggested actions</dt>
						<dd className="text-text-3 break-words">{goal.actions}</dd>
					</div>
				)}
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-3">
					<span>Checked {GOAL_CHECK_FREQUENCY_LABELS[goal.check_frequency]}</span>
					{goal.target_date && <span>Deadline: {formatTargetDate(goal.target_date)}</span>}
				</div>
			</dl>

			<GoalRunsFeed projectId={projectId} goalId={goalId} />

			<CreateGoalDialog
				projectId={projectId}
				goal={goal}
				open={editOpen}
				onOpenChange={setEditOpen}
			/>
		</div>
	);
}
